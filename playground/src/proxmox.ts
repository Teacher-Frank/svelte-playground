import * as https from 'https';

/**
 * ProxmoxAPI - API client for Proxmox VE
 * 
 * Example usage:
 * ```typescript
 * const proxmox = new ProxmoxAPI('192.168.1.100', 8006, 'root', 'pam', 'your-password');
 * 
 * // Authenticate first
 * await proxmox.authenticate();
 * 
 * // Get cluster nodes
 * const nodes = await proxmox.getNodes();
 * console.log(nodes);
 * 
 * // Get cluster status
 * const status = await proxmox.getClusterStatus();
 * console.log(status);
 * ```
 */
export class ProxmoxAPI {
    private host: string;
    private port: number;
    private username: string;
    private realm: string;
    private password: string;
    private ticket: string | null = null;
    private csrf: string | null = null;

    constructor(host: string, port: number, username: string, realm: string, password: string) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.realm = realm;
        this.password = password;
    }

    private log(level: 'info' | 'error' | 'warn', message: string, data?: any): void {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, data || '');
    }

    async authenticate(): Promise<void> {
        try {
            const credentials = btoa(`${this.username}@${this.realm}:${this.password}`);
            const response = await this.request('POST', '/api2/json/access/ticket', {
                username: `${this.username}@${this.realm}`,
                password: this.password,
            });

            this.ticket = response.data.ticket;
            this.csrf = response.data.CSRFPreventionToken;
            this.log('info', 'Authentication successful');
        } catch (error) {
            this.log('error', 'Authentication failed', error);
            throw error;
        }
    }

    private request(method: string, path: string, data?: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                },
                rejectUnauthorized: false,
            };

            if (this.ticket) {
                options.headers['Cookie'] = `PVEAuthCookie=${this.ticket}`;
            }
            if (this.csrf) {
                options.headers['CSRFPreventionToken'] = this.csrf;
            }

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(parsed);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${parsed.errors || body}`));
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse response: ${body}`));
                    }
                });
            });

            req.on('error', (error) => {
                this.log('error', `Request failed: ${method} ${path}`, error);
                reject(error);
            });

            if (data) {
                req.write(JSON.stringify(data));
            }
            req.end();
        });
    }

    async getNodes(): Promise<any> {
        try {
            return await this.request('GET', '/api2/json/nodes');
        } catch (error) {
            this.log('error', 'Failed to get nodes', error);
            throw error;
        }
    }

    async getClusterStatus(): Promise<any> {
        try {
            return await this.request('GET', '/api2/json/cluster/status');
        } catch (error) {
            this.log('error', 'Failed to get cluster status', error);
            throw error;
        }
    }
}