const { MessageFlags, SlashCommandBuilder } = require('discord.js');
const Queue = require('../../queue/queue.js');


const queue = new Queue();

module.exports = {
    data: new SlashCommandBuilder()
    .setName('prompt')
    .setDescription('Send a prompt to our ai agent')
    .addStringOption((option) =>
        option
            .setName('input')
            .setDescription('The prompt to send')
            .setRequired(true)
    ),
    async execute(interaction) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        queue.addItem(interaction);
    }
}