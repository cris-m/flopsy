import { loadConfig, type FlopsyConfig } from '@flopsy/shared';
import type { Message } from '@gateway/types';
import { BaseGateway } from '@gateway/core/base-gateway';
import { WhatsAppChannel } from '@gateway/channels/whatsapp';
import { TelegramChannel } from '@gateway/channels/telegram';
import { DiscordChannel } from '@gateway/channels/discord';
import { LineChannel } from '@gateway/channels/line';
import { SignalChannel } from '@gateway/channels/signal';
import { IMessageChannel } from '@gateway/channels/imessage';

export class FlopsyGateway extends BaseGateway {
    constructor(config?: FlopsyConfig) {
        const cfg = config ?? loadConfig();

        super({
            host: cfg.gateway.host,
            port: cfg.gateway.port,
            token: cfg.gateway.token,
            deduplicationTtlMs: cfg.gateway.deduplication.ttlMs,
            maxDeduplicationEntries: cfg.gateway.deduplication.maxEntries,
        });

        this.registerChannels(cfg);
    }

    private registerChannels(cfg: FlopsyConfig): void {
        const { channels } = cfg;

        if (channels.whatsapp.enabled) {
            this.register(new WhatsAppChannel({
                enabled: true,
                dmPolicy: channels.whatsapp.dm.policy,
                allowFrom: channels.whatsapp.dm.allowFrom,
                blockedFrom: channels.whatsapp.dm.blockedFrom,
                groupPolicy: channels.whatsapp.group.policy,
                allowedGroups: channels.whatsapp.group.allowedGroups,
                sessionPath: channels.whatsapp.sessionPath,
                contextMessages: channels.whatsapp.contextMessages,
                maxChunkSize: channels.whatsapp.maxChunkSize,
                sendReadReceipts: channels.whatsapp.sendReadReceipts,
                autoTyping: channels.whatsapp.autoTyping,
                selfChatMode: channels.whatsapp.selfChatMode,
            }));
        }

        if (channels.telegram.enabled) {
            this.register(new TelegramChannel({
                enabled: true,
                dmPolicy: channels.telegram.dm.policy,
                allowFrom: channels.telegram.dm.allowFrom,
                blockedFrom: channels.telegram.dm.blockedFrom,
                groupPolicy: channels.telegram.group.policy,
                allowedGroups: channels.telegram.group.allowedGroups,
                token: channels.telegram.token,
                groupActivation: channels.telegram.group.activation,
            }));
        }

        if (channels.discord.enabled) {
            this.register(new DiscordChannel({
                enabled: true,
                dmPolicy: channels.discord.dm.policy,
                allowFrom: channels.discord.dm.allowFrom,
                blockedFrom: channels.discord.dm.blockedFrom,
                groupPolicy: channels.discord.guild.policy,
                allowedGroups: channels.discord.guild.allowedGuilds,
                token: channels.discord.token,
                allowedGuilds: channels.discord.guild.allowedGuilds,
                allowedChannels: channels.discord.guild.allowedChannels,
            }));
        }

        if (channels.line.enabled) {
            this.register(new LineChannel({
                enabled: true,
                dmPolicy: channels.line.dm.policy,
                allowFrom: channels.line.dm.allowFrom,
                blockedFrom: channels.line.dm.blockedFrom,
                groupPolicy: channels.line.group.policy,
                allowedGroups: channels.line.group.allowedGroups,
                channelAccessToken: channels.line.channelAccessToken,
                channelSecret: channels.line.channelSecret,
            }));
        }

        if (channels.signal.enabled) {
            this.register(new SignalChannel({
                enabled: true,
                dmPolicy: channels.signal.dm.policy,
                allowFrom: channels.signal.dm.allowFrom,
                blockedFrom: channels.signal.dm.blockedFrom,
                groupPolicy: channels.signal.group.policy,
                allowedGroups: channels.signal.group.allowedGroups,
                account: channels.signal.account,
                cliPath: channels.signal.cliPath,
                deviceName: channels.signal.deviceName,
                sessionPath: channels.signal.sessionPath,
                groupActivation: channels.signal.group.activation,
            }));
        }

        if (channels.imessage.enabled) {
            this.register(new IMessageChannel({
                enabled: true,
                dmPolicy: channels.imessage.dm.policy,
                allowFrom: channels.imessage.dm.allowFrom,
                blockedFrom: channels.imessage.dm.blockedFrom,
                cliPath: channels.imessage.cliPath,
                selfChatMode: channels.imessage.selfChatMode,
            }));
        }
    }

    protected async route(message: Message): Promise<void> {
        this.log.info({ channel: message.channelName, sender: message.peer.id }, 'message routed');
    }
}
