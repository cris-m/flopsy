import { randomBytes } from 'node:crypto';
import forge from 'node-forge';

export interface CertPair {
    certPem: string;
    keyPem: string;
}

const SUBJECT_ROOT = [
    { name: 'commonName', value: 'flopsy-vault root' },
    { name: 'organizationName', value: 'flopsy-vault' },
];

export function generateRootCA(): CertPair {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomBytes(16).toString('hex');
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    cert.setSubject(SUBJECT_ROOT);
    cert.setIssuer(SUBJECT_ROOT);
    cert.setExtensions([
        { name: 'basicConstraints', cA: true, critical: true },
        { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
        { name: 'subjectKeyIdentifier' },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return {
        certPem: forge.pki.certificateToPem(cert),
        keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
}

export function mintLeafCert(rootCertPem: string, rootKeyPem: string, hostname: string): CertPair {
    const rootCert = forge.pki.certificateFromPem(rootCertPem);
    const rootKey = forge.pki.privateKeyFromPem(rootKeyPem);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomBytes(16).toString('hex');
    cert.validity.notBefore = new Date(Date.now() - 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: 'commonName', value: hostname }]);
    cert.setIssuer(rootCert.subject.attributes);
    cert.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        {
            name: 'subjectAltName',
            altNames: [{ type: 2, value: hostname }],
        },
    ]);
    cert.sign(rootKey, forge.md.sha256.create());
    return {
        certPem: forge.pki.certificateToPem(cert),
        keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
}
