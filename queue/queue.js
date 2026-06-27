const { ThreadAutoArchiveDuration, DiscordAPIError, UnfurledMediaItem } = require('discord.js');
const { clearInterval } = require('node:timers');

// wait is a promise-based version of setTimeout
// await wait(3000) lets us pause execution for 3 seconds without blocking the entire process
const wait = require('node:timers/promises').setTimeout;


class Queue {
    // max number of prompts to process at the same time
    static CONCURRENT_QUEUE_SIZE = 3;

    // Ollama LLM model to use for generating purpose
    static LLM_MODEL = "llama3.1:8b"


    constructor() {
        this.queue = {}
        this.interval = undefined;
    }

    // add a new interaction (user prompt) to the queue
    addItem(interaction) {
        const queueLength = this.length();

        // store the interaction
        this.queue[interaction.id] = {
            interaction: interaction,
            status: {
                position: queueLength,
                processing: false,
                waiting: false
            },
            thread: undefined   // discord thread will assigned later
        }

        // if the queue processor isn't running, start it
        // this avoids running multiple intervals at the same time
        if (this.interval == undefined) {
            console.log('Starting the queue processor');
            this.startQueue();
        }
    }

    // Remove a completed or cancelled interaction from the queue
    removeItem(interactionId) {
        console.log(`Removed ${interactionId} from the queue`);
        delete this.queue[interactionId];

        // shift the remaining item's position down by 1
        const interactionIds = Object.keys(this.queue);
        for(let i = 0; i < interactionIds.length; i++) {
            this.queue[interactionIds[i]].status.position--;
        }
    }

    // Look up a queue item by interaction ID without removing it
    getItem(interactionId) {
        return this.queue[interactionId];
    }

    // How many items are currently in the queue
    length() {
        return Object.keys(this.queue).length;
    }

    // check if queue has no items
    isEmpty() {
        return Object.keys(this.queue).length === 0 && this.queue.constructor === Object;
    }

    // Start the queue processor - checks the queue every 3 seconds
    startQueue() {
        this.interval = setInterval(() => this.processQueue(), 3000);
    }

    // Stop the queue processor when there's nothing left to process
    // Clears the interval so it stops firing and resets the reference to undefined
    stopQueue() {
        console.log('Entire queue has been processed. Stopping the queue processor');
        clearInterval(this.interval);
        this.interval = undefined;
    }

    // once a thread has been created, store it in the queue item
    assignThread(interactionId, thread) {
        this.queue[interactionId].thread = thread;
    }

    // called every 3 seconds by the interval - decides what to process next
    processQueue = async () => {
        // if empty -> shut down the interval
        if (this.isEmpty()) {
            this.stopQueue();
            return;
        }

        const interactionIds = Object.keys(this.queue);
        let currentlyBeingProcessedCount = 0;

        for (let i = 0; i < interactionIds.length; i++) {
            const interactionId = interactionIds[i];
            const positionInQueue = this.queue[interactionId].status.position;
            const processing = this.queue[interactionId].status.processing;
            const interaction = this.queue[interactionId].interaction;
            const channelId = this.queue[interactionId].interaction.channelId;        
            // Fetch the discord channel to create threads init
            const channel = await this.queue[interactionId].interaction.client.channels.fetch(channelId);
            
            // Check if it's unprocessed
            if(!processing && currentlyBeingProcessedCount < Queue.CONCURRENT_QUEUE_SIZE) {
                console.log(`Processing task with interaction id ${interactionId}`);
                this.queue[interactionId].status.processing = true;
                this.processTask(interaction, channel);

                currentlyBeingProcessedCount++;
            } else if(!processing && currentlyBeingProcessedCount > Queue.CONCURRENT_QUEUE_SIZE) {

                // slots are full - wait 3 seconds first to avoid discord's 5 requests/second rate limit
                await wait(3000);
                await interaction.editReply(`There are ${positionInQueue - Queue.CONCURRENT_QUEUE_SIZE}` 
                    + ` people ahead of you in the queue. Please wait your turn...`
                );
            } else {
                currentlyBeingProcessedCount++;
            }
        }
    }

    // Handles the actual LLM rrequest and streaming the response into a Discord thread
    processTask = async (interaction, channel) => {
        const prompt = interaction.options.getString('input');
        const userId = interaction.user.id;
        const userName = interaction.user.displayName;

        console.log(`User send message ${userId} with prompt: ${prompt}`);


        // create a dedicated discord thread for this prompt so responses don't clutter the main channel
        const newThread = await channel.threads.create({
            name: `[${userName} - Prompt: ${prompt ?? "Prompt"}]`,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneHour, // auto-archive after 1 hour
            reason: "LLM Bot Auto Created Thread",
        });

        // save the thread to be referenced later
        this.assignThread(interaction.id, newThread);

        // Ollama's local API for generating text
        const url = 'http://localhost:11434/api/generate';

        const data = {
            prompt: interaction.options.getString('input'),
            model: Queue.LLM_MODEL,
            stream: true // response come back in chunks instead of all at once
        };

        // capture removed item in a local closure so it can be called from inside the stream
        const removedItem = (interactionId) => {
            this.removeItem(interactionId);
        };


        // send the prompt to Ollama and handle the response
        fetch(url, {
            method: "POST",
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        })
        .then((response) => {
            // set up a stream reader to read the response chunk by chunk
            const reader = response.body?.getReader();
            const decoder = new TextDecoder();

            let result = ""; // accumulates the current Discord message's text
            let responseChunks = []; // store message content

            let messages = []; // store Discord Message objects


            // Discord has rate limits, so we can't edit messages on every chunks
            // Instead, this function runs every 2 seconds and syncs Discord messages
            // with the latest chunks
            const throttleResponse = async () => {
                // if a new chunk exists that doesn't have a Discord message yet, send one
                if (messages.length === 0 || messages.length !== responseChunks.length) {
                    const message = await newThread.send(responseChunks[responseChunks.length - 1]);

                    messages.push(message);
                }

                // update any existing messages whose content has changed since we last edited them
                for (let i = 0; i < messages.length; i++) {
                    if (messages[i].content !== responseChunks[i]) {
                        messages[i].edit(responseChunks[i]);
                    }
                }
            };

            // Start the throttled update loop - syncs Discord every 2 second while streaming
            const throttleResponseInterval = setInterval(() => throttleResponse(), 2000);

            return new ReadableStream({
                start(controller) {
                    return pump();

                    // recursive function that reads one chunk at a time from Ollama stream
                    function pump() {
                        return reader?.read().then(async function ({ done, value }) {
                            // stream is finished - do final cleanup
                            if(done) {
                                console.log(`Task with interaction id ${interaction.id} complete.`);

                                // wait 2 second to let any pending throttle updates finish
                                await wait(2000);

                                // do one final edit to make sure the last message is up to date
                                messages[messages.length - 1].edit(responseChunks[responseChunks.length - 1]);

                                // stop the throttle interval since we're done streaming
                                clearInterval(throttleResponseInterval);

                                // delete 'thinking...' reply from the slash comma
                                await interaction.deleteReply();

                                // remove this task from the queue
                                removeItem(interaction.id);

                                controller.close();
                                return;
                            }

                            // Decode the raw bytes and extract the text portion of Ollama's JSON response
                            const chunk = JSON.parse(decoder.decode(value)).response;

                            // initialize the first chunk
                            if(responseChunks.length === 0) {
                                responseChunks.push(result);
                            }

                            // Discord have a 2000 character limit for messages
                            // If adding this chunk exceed 1800 chars (buffer for safety)
                            // start a new message bucket and reset the result tracker
                            if(result.length + chunk.length > 1800) {
                                responseChunks.push(chunk);
                                result = "";
                            } else {
                                // append the chunk the current message bucket
                                responseChunks[responseChunks.length - 1] = responseChunks[responseChunks.length - 1].concat(chunk);
                                result += chunk;
                            }

                            // pass the raw chunk along to the stream consumer
                            controller.enqueue(value);

                            // read the next chunk
                            return pump();
                        });
                    }
                }
            })
        })
        .catch(async (error) => {
            console.error(error);

            // if user tries to send a message in the thread while the bot is processing, may desync the message list
            if (error instanceof DiscordAPIError && error.code === 10008) {
                await newThread.send('WARNING: Sending messages in the same thread as the bot while processing may break the response.');
            }

            await interaction.deleteReply();
            await interaction.editReply("An error occured. Please try again later.");
        });
    }
}

module.exports = Queue;