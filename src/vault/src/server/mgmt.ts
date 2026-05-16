import { createServer, type Server } from 'node:http';

export interface MgmtServerOptions {
    host: string;
    port: number;
    getStatus: () => { unsealed: boolean; secrets: number; tokens: number; rules: number };
}

export interface MgmtServerHandle {
    server: Server;
    close: () => Promise<void>;
    address: () => string;
}

export function startMgmtServer(opts: MgmtServerOptions): Promise<MgmtServerHandle> {
    const server = createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            const s = opts.getStatus();
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ status: 'ok', ...s }));
            return;
        }
        if (req.method === 'GET' && req.url === '/v1/status') {
            const s = opts.getStatus();
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(s));
            return;
        }
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
            server.removeListener('error', reject);
            resolve({
                server,
                close: () => new Promise<void>((res) => server.close(() => res())),
                address: () => `${opts.host}:${opts.port}`,
            });
        });
    });
}
