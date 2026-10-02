// Independent adapter around the maintained MIT eventsource-parser package.
// The caller passes binary fetch chunks and receives browser MessageEvents.
export const eventSourceStreamSource = String.raw`
import { createParser } from '/plugin-runtime/vendor/eventsource-parser/index.js';
export default class EventSourceStream {
  constructor() {
    const decoder = new TextDecoder();
    let lastEventId = '';
    let parser;
    const stream = new TransformStream({
      start(controller) {
        parser = createParser({
          onId(id) { lastEventId = id; },
          onEvent(event) {
            controller.enqueue(new MessageEvent(event.event || 'message', { data: event.data, lastEventId }));
          },
        });
      },
      transform(chunk) { parser.feed(decoder.decode(chunk, { stream: true })); },
      flush() {
        parser.feed(decoder.decode());
        // SSE only dispatches events terminated by an empty line.
        parser.reset();
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
  }
}
export const getEventSourceStream = () => new EventSourceStream();
`;
