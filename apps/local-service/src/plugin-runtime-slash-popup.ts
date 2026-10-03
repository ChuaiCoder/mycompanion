// Per-invocation dependencies for unmodified Tavern popup command callbacks.
// No ambient async controller: each original callback retains its own bindings.
export const slashPopupSource = String.raw`
import {Popup,PopupUtils,POPUP_TYPE} from '/scripts/popup.js';
import {abortableSlashDelay} from '/plugin-runtime/slash-adapter.js';

export async function runSlashPopupCommand(name,args,value,createCallbacks) {
  const controller=args._abortController;
  if(controller?.signal.aborted)return '';
  const popups=new Set();
  const reason=()=>new DOMException('Popup command stopped','AbortError');
  let rejectAbort;
  const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
  const abort=()=>{
    const error=reason();
    for(const popup of popups)popup.cancelForLifecycle(error);
    rejectAbort(error);
  };
  const assertActive=()=>{if(controller?.signal.aborted)throw reason();};
  const ScopedPopup=class extends Popup {
    constructor(...options){super(...options);popups.add(this);}
    show(){
      if(controller?.signal.aborted){
        const error=reason();this.cancelForLifecycle(error);return Promise.reject(error);
      }
      const shown=super.show();
      void shown.then(()=>popups.delete(this),()=>popups.delete(this));
      return shown;
    }
  };
  const show=(type,header,text,inputValue,options)=>new ScopedPopup(PopupUtils.BuildTextWithHeader(header,text),type,inputValue,options).show();
  ScopedPopup.show={
    text:(header,text,options={})=>show(POPUP_TYPE.TEXT,header,text,'',options),
    confirm:(header,text,options={})=>show(POPUP_TYPE.CONFIRM,header,text,'',options),
    input:async(header,text,inputValue='',options={})=>{
      const result=await show(POPUP_TYPE.INPUT,header,text,inputValue,options);
      return result===''?'':result?String(result):null;
    },
  };
  const callbacks=createCallbacks({Popup:ScopedPopup,
    callGenericPopup:(content,type,inputValue='',options={})=>new ScopedPopup(content,type,inputValue,options).show(),
    delay:async amount=>{await abortableSlashDelay(amount,controller);assertActive();},
  });
  controller?.addEventListener('abort',abort);
  try {
    assertActive();
    return await Promise.race([Promise.resolve().then(()=>{assertActive();return callbacks[name](args,value);}),cancelled]);
  } catch(error) {
    if(controller?.signal.aborted)return '';
    throw error;
  } finally {
    controller?.removeEventListener('abort',abort);
    for(const popup of popups)popup.cancelForLifecycle(reason());
    popups.clear();
  }
}
`;
