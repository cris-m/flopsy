'use strict';

const tls = require('tls');
const fs = require('fs');

let caInjected = false;
const caFile = process.env.NODE_EXTRA_CA_CERTS;
if (caFile) {
    try {
        const stat = fs.statSync(caFile);
        const mode = stat.mode & 0o777;
        if (stat.uid !== process.getuid()) {
            process.stderr.write('[vault-ca-hook] FATAL: ' + caFile + ' not owned by current user\n');
            process.exit(2);
        }
        if (mode & 0o022) {
            process.stderr.write('[vault-ca-hook] FATAL: ' + caFile + ' is group/world writable (mode ' + mode.toString(8) + ')\n');
            process.exit(2);
        }
        const extraPem = fs.readFileSync(caFile, 'utf8');
        if (extraPem.includes('BEGIN CERTIFICATE')) {
            const systemCAs = tls.rootCertificates;
            const origCreate = tls.createSecureContext;
            tls.createSecureContext = function patchedCreateSecureContext(options) {
                const opts = options || {};
                if (opts.ca) {
                    const userCAs = Array.isArray(opts.ca) ? opts.ca : [opts.ca];
                    opts.ca = [...userCAs, extraPem];
                    return origCreate.call(this, opts);
                }
                const ctx = origCreate.call(this, opts);
                try {
                    for (const root of systemCAs) {
                        try { ctx.context.addCACert(root); } catch { /* ignore dup */ }
                    }
                    ctx.context.addCACert(extraPem);
                    caInjected = true;
                } catch (err) {
                    process.stderr.write('[vault-ca-hook] FATAL: addCACert failed: ' + err.message + '\n');
                    process.exit(2);
                }
                return ctx;
            };
            process.stderr.write('[vault-ca-hook] vault CA injected into TLS layer (' + caFile + ', ' + systemCAs.length + ' system roots preserved)\n');
        } else {
            process.stderr.write('[vault-ca-hook] ' + caFile + ' has no PEM certificate, skipping\n');
        }
    } catch (err) {
        process.stderr.write('[vault-ca-hook] FATAL: failed to read ' + caFile + ': ' + err.message + '\n');
        process.exit(2);
    }
}

const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
if (httpsProxy || httpProxy) {
    if (!process.env.GLOBAL_AGENT_HTTPS_PROXY) {
        process.env.GLOBAL_AGENT_HTTPS_PROXY = httpsProxy;
    }
    if (!process.env.GLOBAL_AGENT_HTTP_PROXY) {
        process.env.GLOBAL_AGENT_HTTP_PROXY = httpProxy;
    }
    if (!process.env.GLOBAL_AGENT_NO_PROXY && process.env.NO_PROXY) {
        process.env.GLOBAL_AGENT_NO_PROXY = process.env.NO_PROXY;
    }
    // global-agent intentionally not bootstrapped: it rejects https:// proxy URLs,
    // and even with a plain HTTP variant its HttpsProxyAgent fails TLS hostname
    // validation against the MITM leaf cert (passes proxy host instead of upstream).
    // Channels using node-fetch / global-agent will fall through to direct HTTPS
    // (using credentials already in process.env). Only undici / native fetch routes
    // through HTTPS_PROXY, which is the modern path agent-vault recommends.

    try {
        const undici = require('undici');
        if (undici && undici.setGlobalDispatcher && undici.ProxyAgent) {
            const proxyUri = httpsProxy || httpProxy;
            let cleanUri = proxyUri;
            let authToken = null;
            try {
                const parsed = new URL(proxyUri);
                if (parsed.username) {
                    const user = decodeURIComponent(parsed.username);
                    const pass = parsed.password ? decodeURIComponent(parsed.password) : '';
                    authToken = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
                    parsed.username = '';
                    parsed.password = '';
                    cleanUri = parsed.toString();
                }
            } catch (urlErr) {
                process.stderr.write('[vault-ca-hook] undici proxy URL parse failed: ' + urlErr.message + '\n');
            }
            const dispatcherOpts = { uri: cleanUri };
            if (authToken) dispatcherOpts.token = authToken;
            if (caFile && fs.existsSync(caFile)) {
                try {
                    const caPem = fs.readFileSync(caFile, 'utf8');
                    dispatcherOpts.requestTls = { ca: caPem };
                } catch (caErr) {
                    process.stderr.write('[vault-ca-hook] undici CA load failed: ' + caErr.message + '\n');
                }
            }
            undici.setGlobalDispatcher(new undici.ProxyAgent(dispatcherOpts));
            process.stderr.write('[vault-ca-hook] undici ProxyAgent installed — fetch() routed via HTTPS_PROXY (auth=' + (authToken ? 'Basic' : 'none') + ')\n');
        }
    } catch (err) {
        process.stderr.write('[vault-ca-hook] undici dispatcher setup skipped: ' + err.message + '\n');
    }
}
