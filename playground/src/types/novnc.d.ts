declare module '@novnc/novnc' {
  export type RFBCredentials = {
    username?: string;
    password?: string;
    target?: string;
  };

  export type RFBOptions = {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  };

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket | RTCDataChannel, options?: RFBOptions);

    background: string;
    clipViewport: boolean;
    focusOnClick: boolean;
    resizeSession: boolean;
    scaleViewport: boolean;

    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
  }
}
