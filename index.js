require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');


const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// create a client instance and set the intents to listen for messages
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// add a commands property to client
client.commands = new Collection();
client.cooldowns = new Collection();

// get the commandFolder path
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);



// get all the commands loaded into client.commands
for (const folder of commandFolders) {
    // return an array of all the file names in the given directory and filters only for .js files
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the .commands with the key as the command name and the value as its exported module
        if('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

// get the eventFolder
const eventsPath = path.join(__dirname, "events");
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args));
    } else {
        client.on(event.name, (...args) => event.execute(...args));
    }
}

client.login(BOT_TOKEN);
