export const characterFieldsSource = String.raw`
import {getContext,eventSource,event_types} from '/plugin-runtime/compat-runtime.js';
import {getOneCharacter} from '/plugin-runtime/characters.js';
import {lodash} from '/plugin-runtime/libraries.js';
const queues=new Map();
export function writeExtensionField(index,key,value){
  const character=getContext().characters[Number(index)];
  if(!character) return Promise.reject(new Error('Character not found: '+index));
  const avatar=character.avatar,snapshot=structuredClone(value),before=structuredClone(lodash.get(character.data.extensions,key));
  const pending=(queues.get(avatar)??Promise.resolve()).catch(()=>{}).then(async()=>{
    // The server merges only this field with the latest card, preserving other
    // extensions and concurrent editor updates rather than resending a snapshot.
    const response=await fetch('/api/characters/extension-field',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({avatar_url:avatar,key,value:snapshot})});
    if(!response.ok)throw new Error('Character extension save failed: '+await response.text());
    const live=getContext().characters.find(item=>item.avatar===avatar);
    if(live){const current=lodash.get(live.data.extensions,key),next=lodash.isEqual(current,before)?snapshot:current;lodash.set(live.data.extensions,key,next);const card=JSON.parse(live.json_data);lodash.set(card.data.extensions,key,next);live.json_data=JSON.stringify(card);}
    await getOneCharacter(avatar);
  });
  queues.set(avatar,pending);
  return pending.then(async()=>{const id=getContext().characters.findIndex(item=>item.avatar===avatar);if(id>=0)await eventSource.emit(event_types.CHARACTER_EDITED,{detail:{id,character:getContext().characters[id]}});});
}
export async function flushCharacterFieldWrites(){await Promise.all(queues.values());}
`;
