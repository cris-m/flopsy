export class AcpError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
        super(message);
        this.name = 'AcpError';
        this.code = code;
    }
}

export class AcpSdkMissingError extends AcpError {
    constructor() {
        super('@agentclientprotocol/sdk is not installed. Run: npm i @agentclientprotocol/sdk', 'sdk_missing');
    }
}
