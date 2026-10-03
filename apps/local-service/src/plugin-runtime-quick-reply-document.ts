/** Adapt the original QR DOM accesses to the existing React composer callbacks. */
export const quickReplyDocumentSource=String.raw`
let host;
export function connectQuickReplyDocument(value){host=value;}
export const quickReplyDocument={querySelector(selector){
  const node=globalThis.document.querySelector(selector);if(!node)return node;
  if(selector==='#send_textarea')return {
    get value(){return node.value;},
    set value(value){node.value=String(value);host?.input?.(node.value);},
    focus:()=>node.focus(),
  };
  if(selector==='#send_but'&&host?.send)return {click(){
    // Preserve actual button behavior during an in-flight native generation.
    if(node.disabled)return;
    const value=globalThis.document.querySelector('#send_textarea')?.value??'';
    Promise.resolve(host.send(value)).catch(error=>host?.error?.(error));
  }};
  return node;
}};
`;
