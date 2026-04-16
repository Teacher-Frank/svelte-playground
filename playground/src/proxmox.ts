/// <reference types="node" />
import * as https from 'https';

/**
 * ProxmoxAPI - API client for Proxmox VE 9.1.6
 * 
 * Example usage:
 * ```typescript
 * const proxmox = new ProxmoxAPI('192.168.1.100', 8006, 'root', 'pam', 'Defcon54!');
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
    /** Proxmox server hostname or IP address */
    private host: string;
    /** Proxmox server port (default: 8006) */
    private port: number;
    /** Username for authentication */
    private username: string;
    /** Authentication realm (e.g., 'pam', 'pve') */
    private realm: string;
    /** Password for authentication */
    private password: string;
    /** Authentication ticket received after login */
    private ticket: string | null = null;
    /** CSRF prevention token received after login */
    private csrf: string | null = null;

    /**
     * Creates a new ProxmoxAPI client instance
     * @param host - Proxmox server hostname or IP address
     * @param port - Proxmox server port (typically 8006)
     * @param username - Username for authentication
     * @param realm - Authentication realm (e.g., 'pam', 'pve')
     * @param password - Password for authentication
     */
    constructor(host: string, port: number, username: string, realm: string, password: string) {
        this.host = host;
        this.port = port;
        this.username = username;
        this.realm = realm;
        this.password = password;
    }

    /**
     * Logs a message with timestamp and level
     * @param level - Log level (info, error, or warn)
     * @param message - Message to log
     * @param data - Optional additional data to log
     * @private
     */
    private log(level: 'info' | 'error' | 'warn', message: string, data?: unknown): void {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, data || '');
    }

    /**
     * Authenticates with the Proxmox server and obtains authentication ticket and CSRF token
     * Must be called before making any API requests
     * @throws {Error} If authentication fails
     * @example
     * ```typescript
     * await proxmox.authenticate();
     * ```
     */
    async authenticate(): Promise<void> {
        try {
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

    /**
     * Makes an HTTP request to the Proxmox API
     * @param method - HTTP method (GET, POST, PUT, DELETE, etc.)
     * @param path - API endpoint path
     * @param data - Optional request body data
     * @returns Promise resolving to the parsed JSON response
     * @throws {Error} If the request fails or returns a non-2xx status code
     * @private
     */
    private request(method: string, path: string, data?: unknown): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                } as Record<string, string>,
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
                    } catch {
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

    /**
     * Retrieves the list of nodes in the Proxmox cluster
     * @returns Promise resolving to the cluster nodes data
     * @throws {Error} If the request fails
     * @example
     * ```typescript
     * const nodes = await proxmox.getNodes();
     * console.log(nodes.data);
     * ```
     */
    async getNodes(): Promise<Record<string, unknown>> {
        try {
            return await this.request('GET', '/api2/json/nodes');
        } catch (error) {
            this.log('error', 'Failed to get nodes', error);
            throw error;
        }
    }

    /**
     * Retrieves the current status of the Proxmox cluster
     * @returns Promise resolving to the cluster status data
     * @throws {Error} If the request fails
     * @example
     * ```typescript
     * const status = await proxmox.getClusterStatus();
     * console.log(status.data);
     * ```
     */
    async getClusterStatus(): Promise<Record<string, unknown>> {
        try {
            return await this.request('GET', '/api2/json/cluster/status');
        } catch (error) {
            this.log('error', 'Failed to get cluster status', error);
            throw error;
        }
    }
}