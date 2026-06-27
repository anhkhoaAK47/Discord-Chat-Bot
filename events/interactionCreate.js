const { Events, MessageFlags, Collection } = require('discord.js');

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        // if interaction is not a slash command, exit
        if (!interaction.isChatInputCommand()) return;
        console.log(interaction);

        const command = interaction.client.commands.get(interaction.commandName);
        
        // if command doesn't exist, exit
        if (!command) {
            console.error(`No command matching ${interaction.commandName} was found.`);
            return;
        }
        
        const { cooldowns } = interaction.client;
        
        // if this command has never been used before -> create a fresh empty collection for it
        // The "inner" dictionary that will track which users used this command and when
        if (!cooldowns.has(command.data.name)) {
            cooldowns.set(command.data.name, new Collection());
        }
        
        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const defaultCooldownDuration = 3;
        const cooldownAmount = (command.cooldown ?? defaultCooldownDuration) * 1000;
        
        if (timestamps.has(interaction.user.id)) { // check if this user has used this command before
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
        
            if (now < expirationTime) {
                const remainingTime = ((expirationTime - now) / 1000).toFixed(1);
                return interaction.reply({
                    content: `Please wait for \`${command.data.name}\` to cooldown. You can use it again in \`${remainingTime}s\`.`,
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
        
        // Delete the entry for the user under the specified command after the command's cooldown time
        // has expired for them
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);
        
        
        try {
            await command.execute(interaction);
        } catch (error) {
            console.error(error);
            if (interaction.replied || interaction.deferred) {
                // If the interaction has already been replied to or deferred, we can follow up with an error message
                await interaction.followUp({
                    content: 'There was an error while executing this command!',
                    flags: MessageFlags.Ephemeral, // Ephemeral messages are only visible to the user
                });
            } else {
                // If the interaction has not been replied to or deferred, we can reply directly
                await interaction.reply({
                    content: 'There was an error while executing this command!',
                    flags: MessageFlags.Ephemeral,
                });
            }
        }
    }
}