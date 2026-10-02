// Apply a committed native delta only over its unchanged base. Locally edited
// values remain in the normal save queues and are not overwritten by an event.
export const macroVariableSyncSource = String.raw`
export function applyMacroVariableChange(store,change){
  if(Object.hasOwn(store,change.key)!==change.beforeExists||JSON.stringify(Object.hasOwn(store,change.key)?store[change.key]:undefined)!==JSON.stringify(change.before))return;
  if(change.afterExists)Object.defineProperty(store,change.key,{value:structuredClone(change.after),writable:true,enumerable:true,configurable:true});
  else delete store[change.key];
}
`;
