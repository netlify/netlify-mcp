import { Transport } from "https://esm.sh/@modelcontextprotocol/sdk@1.7.0/dist/esm/shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "https://esm.sh/@modelcontextprotocol/sdk@1.7.0/dist/esm/types.js";

/**
 * Server transport for SSE: this will send messages over an SSE connection and receive messages from HTTP POST requests.
 */
export class SSEStandardTransport implements Transport {
  private _controller: ReadableStreamDefaultController<string> | null = null;
  private _sessionId: string;
  private _stream: ReadableStream<string>;
  private _response: Response | undefined;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /**
   * Creates a new SSE server transport, which will direct the client to POST messages to the relative or absolute URL identified by `_endpoint`.
   */
  constructor(
    private _endpoint: string
  ) {
    this._sessionId = crypto.randomUUID();
    this._stream = new ReadableStream({
      start: (controller) => {
        this._controller = controller;
      },
      cancel: () => {
        this.close();
      }
    });
  }

  /**
   * Handles the initial SSE connection request.
   *
   * This should be called when a GET request is made to establish the SSE stream.
   */
  async start(): Promise<void> {
    if (this._controller === null) {
      throw new Error(
        "SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this._response = new Response(this._stream.pipeThrough(new TextEncoderStream()), {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

    // Send the endpoint event
    this._controller.enqueue(
      `event: endpoint\ndata: ${encodeURI(this._endpoint)}?sessionId=${this._sessionId}\n\n`
    );
  }

  /**
   * Handles incoming POST messages.
   *
   * This should be called when a POST request is made to send a message to the server.
   */
  async handlePostMessage(
    req: Request,
    res: Response,
  ): Promise<Response> {
    if (this._controller === null) {
      const message = "SSE connection not established";
      return new Response(message, { status: 500 });
    }

    try {
      const contentTypeHeader = req.headers.get("content-type") || "";
      if (!contentTypeHeader.includes("application/json")) {
        throw new Error(`Unsupported content-type: ${contentTypeHeader}`);
      }

      const body = await req.json();
      await this.handleMessage(body);

      return new Response("Accepted", { status: 202 });
    } catch (error) {
      this.onerror?.(error as Error);
      return new Response(String(error), { status: 400 });
    }
  }

  /**
   * Handle a client message, regardless of how it arrived. This can be used to inform the server of messages that arrive via a means different than HTTP POST.
   */
  async handleMessage(message: unknown): Promise<void> {
    let parsedMessage: JSONRPCMessage;
    try {
      parsedMessage = JSONRPCMessageSchema.parse(message);
    } catch (error) {
      this.onerror?.(error as Error);
      throw error;
    }

    this.onmessage?.(parsedMessage);
  }

  async close(): Promise<void> {
    if (this._controller) {
      this._controller.close();
      this._controller = null;
    }

    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this._controller) {
      throw new Error("Not connected");
    }

    this._controller.enqueue(
      `event: message\ndata: ${JSON.stringify(message)}\n\n`
    );
  }

  /**
   * Returns the session ID for this transport.
   *
   * This can be used to route incoming POST requests.
   */
  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Returns the response for this transport.
   *
   * This can be used to stream back to clients.
   */
  get response(): Response {
    if (!this._response) {
      throw new Error("Response not established");
    }
    return this._response;
  }
}
