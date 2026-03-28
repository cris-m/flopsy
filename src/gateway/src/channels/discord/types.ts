import type { BaseChannelConfig } from '@gateway/types';

export type DiscordStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type DiscordActivityType = 'playing' | 'streaming' | 'listening' | 'watching' | 'competing';

export interface DiscordPresence {
    status?: DiscordStatus;
    activity?: string;
    activityType?: DiscordActivityType;
    activityUrl?: string;
}

export interface DiscordSlashCommand {
    name: string;
    description: string;
}

export interface DiscordChannelConfig extends BaseChannelConfig {
    token: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
    presence?: DiscordPresence;
    slashCommands?: DiscordSlashCommand[];
    devGuildId?: string;
}
