# Svelte library

Everything you need to build a Svelte library, powered by [`sv`](https://npmjs.com/package/sv).

Read more about creating a library [in the docs](https://svelte.dev/docs/kit/packaging).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project in the current directory
npx sv create

# create a new project in my-app
npx sv create my-app
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.13.0 create --template library --types ts --add eslint vitest="usages:component,unit" --install npm playground
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

Everything inside `src/lib` is part of your library, everything inside `src/routes` can be used as a showcase or preview app.

## Building

To build your library:

```sh
npm pack
```

To create a production version of your showcase app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Proxmox Console Routes

The Proxmox admin page exposes two browser consoles for running workloads:

- Terminal route: `/proxmox/terminal?vmid=<id>&node=<node>&type=<vm|container>&name=<optional>`
- GUI route (noVNC): `/proxmox/vnc?vmid=<id>&node=<node>&type=<vm|container>&name=<optional>`

Both routes open websocket bridges on the same origin:

- Terminal websocket: `/proxmox/terminal/ws`
- VNC websocket: `/proxmox/vnc/ws`

Why the bridge exists: browser clients cannot safely attach Proxmox auth headers/cookies to arbitrary websocket targets. The server bridge keeps credentials and short-lived tickets server-side and forwards only terminal/RFB frames.

## Required Environment Variables

Set these variables before running the playground when Proxmox integration is enabled:

- `PVE_BASE_URL`: Proxmox API base URL (example: `https://pve.example.com:8006`)
- Authentication (choose one):
- `PVE_API_TOKEN`: API token in `PVEAPIToken=user@realm!token=secret` format (or shorthand supported by pve-client)
- `PVE_USERNAME`, `PVE_PASSWORD`, optional `PVE_REALM` (defaults to `pam`)
- Optional TLS override for local/self-signed labs: `PVE_INSECURE_TLS=true`

Notes:

- GUI and terminal actions are only enabled for running workloads with known `vmid` and `node`.
- In production, prefer valid TLS certificates and keep `PVE_INSECURE_TLS` unset.
- **VM VNC**: Proxmox's native framebuffer console, works out-of-the-box for QEMU VMs.
- **Container GUI**: LXC containers do not expose a native framebuffer. See [LXC-VNC-Button-Guide.md](./LXC-VNC-Button-Guide.md) for how to wire a desktop + VNC service inside a container to the VNC button.

## Publishing

Go into the `package.json` and give your package the desired name through the `"name"` option. Also consider adding a `"license"` field and point it to a `LICENSE` file which you can create from a template (one popular option is the [MIT license](https://opensource.org/license/mit/)).

To publish your library to [npm](https://www.npmjs.com):

```sh
npm publish
```
