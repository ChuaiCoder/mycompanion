// Executed by the packaged feature driver with its real Chromium document.
// Source syntax checks alone are not actual EXE acceptance evidence.
// Each body expects {core,wait,check} from window.packagedFeatures.
export const packagedSlashPopupStageBodies = {
  input: String.raw`
    const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');
    const {Popup}=await import('/scripts/popup.js');
    const options={handleParserErrors:false,handleExecutionErrors:false};
    const find=marker=>Popup.util.popups.find(p=>p.dlg.open&&p.content.textContent.includes(marker));
    const before=JSON.stringify(core.getContext().chat);
    const pending=executeSlashCommandsWithOptions('/let key=handler unset | /let key=who packaged-scope | /input default=seed rows=3 wide=true placeholder=hint tooltip=tip okButton=Choose onSuccess={: /var key=handler {{var::who}} :} PACKAGED_SLASH_INPUT <b>Question</b><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==" onerror="window.packagedUnsafe=1"> | /pass {{pipe}}/{{var::handler}}',options);
    await wait(()=>find('PACKAGED_SLASH_INPUT'),'candidate original input dialog');
    const shown=find('PACKAGED_SLASH_INPUT');
    check(shown.dlg.matches(':modal')&&document.activeElement===shown.mainInput,'candidate native modal input focus');
    check(shown.mainInput.value==='seed'&&shown.mainInput.rows===3&&shown.mainInput.placeholder==='hint'&&shown.mainInput.title==='tip'&&shown.okButton.textContent==='Choose','candidate original input options');
    check(shown.content.querySelector('b')?.textContent==='Question'&&!shown.content.querySelector('img').hasAttribute('onerror'),'candidate input actual sanitized display');
    shown.mainInput.value='  entered  ';shown.mainInput.dispatchEvent(new Event('input',{bubbles:true}));shown.okButton.click();
    const result=await pending;
    check(result.pipe==='  entered  /packaged-scope'&&!result.isAborted&&!result.isError,'candidate input returned exact whitespace and lexical success closure');
    check(!shown.dlg.isConnected,'candidate input dialog disposed');
    const cancelled=executeSlashCommandsWithOptions('/let key=handler unset | /let key=who packaged-cancel | /prompt onCancel={: /var key=handler {{var::who}} :} PACKAGED_SLASH_PROMPT | /pass {{pipe}}/{{var::handler}}',options);
    await wait(()=>find('PACKAGED_SLASH_PROMPT'),'candidate original input alias');
    find('PACKAGED_SLASH_PROMPT').cancelButton.click();
    const cancel=await cancelled;
    check(cancel.pipe==='/packaged-cancel'&&!cancel.isAborted&&!cancel.isError,'candidate prompt alias executes lexical user cancel closure');
    check(JSON.stringify(core.getContext().chat)===before&&!find('PACKAGED_SLASH_INPUT')&&!find('PACKAGED_SLASH_PROMPT')&&window.packagedUnsafe!==1,'candidate input no accepted chat mutation or unsafe HTML');
    return{inputPipe:result.pipe,promptCancelled:true,lexicalScope:true,nativeModal:true,dialogsDisposed:true};
  `,
  popup: String.raw`
    const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');
    const {Popup}=await import('/scripts/popup.js');
    const options={handleParserErrors:false,handleExecutionErrors:false};
    const find=marker=>Popup.util.popups.find(p=>p.dlg.open&&p.content.textContent.includes(marker));
    const before=JSON.stringify(core.getContext().chat);
    const raw='PACKAGED_SLASH_POPUP <b>Body</b><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgEpH7DwABpAE8k4sOtwAAAABJRU5ErkJggg==" onerror="window.packagedUnsafe=1">';
    const pending=executeSlashCommandsWithOptions('/popup header="<i>Header</i>" wide=true wider=true transparent=true scroll=false tooltip=tip okButton=Yes cancelButton=No '+raw,options);
    await wait(()=>find('PACKAGED_SLASH_POPUP'),'candidate original popup');
    const shown=find('PACKAGED_SLASH_POPUP');
    check(shown.dlg.matches(':modal')&&shown.content.querySelector('h3 i')?.textContent==='Header'&&shown.content.querySelector('b')?.textContent==='Body','candidate popup native modal and original header/body');
    check(!shown.content.querySelector('img').hasAttribute('onerror')&&shown.content.title==='tip'&&shown.cancelButton.textContent==='No','candidate popup sanitize tooltip and caption');
    check(['wide','wider','transparent'].every(name=>shown.dlg.classList.contains(name+'_dialogue_popup'))&&!shown.dlg.classList.contains('vertical_scrolling_dialogue_popup'),'candidate popup original sizing and scrolling');
    shown.cancelButton.click();const result=await pending;
    check(result.pipe===raw&&!result.isAborted&&!result.isError,'candidate ordinary cancel preserves raw popup text pipe');
    const choice=executeSlashCommandsWithOptions('/popup result=true cancelButton=No PACKAGED_SLASH_POPUP_RESULT',options);
    await wait(()=>find('PACKAGED_SLASH_POPUP_RESULT'),'candidate result popup');find('PACKAGED_SLASH_POPUP_RESULT').cancelButton.click();
    const selected=await choice;check(selected.pipe==='0'&&!selected.isAborted&&!selected.isError,'candidate original popup result returns cancel zero');
    check(!shown.dlg.isConnected&&!find('PACKAGED_SLASH_POPUP_RESULT')&&JSON.stringify(core.getContext().chat)===before&&window.packagedUnsafe!==1,'candidate popup disposed with no chat mutation or unsafe HTML');
    return{rawPipePreserved:true,ordinaryCancel:true,resultCancelPipe:selected.pipe,nativeModal:true,dialogsDisposed:true};
  `,
  buttons: String.raw`
    const {executeSlashCommandsWithOptions}=await import('/scripts/slash-commands.js');
    const {Popup}=await import('/scripts/popup.js');
    const options={handleParserErrors:false,handleExecutionErrors:false};
    const find=marker=>Popup.util.popups.find(p=>p.dlg.open&&p.content.textContent.includes(marker));
    const before=JSON.stringify(core.getContext().chat);
    const single=executeSlashCommandsWithOptions('/buttons labels=[{"text":"<b>A</b>","icon":"fa-save","tooltip":"Save"},"B"] PACKAGED_SLASH_SINGLE',options);
    await wait(()=>find('PACKAGED_SLASH_SINGLE'),'candidate original buttons single');const first=find('PACKAGED_SLASH_SINGLE');
    const a=first.content.querySelector('[data-result="2"]');
    check(first.dlg.matches(':modal')&&a.textContent==='<b>A</b>'&&!a.querySelector('b')&&a.title==='Save'&&a.querySelector('i').classList.contains('fa-save'),'candidate original literal label icon tooltip');
    check(getComputedStyle(a).display==='flex'&&getComputedStyle(first.content.querySelector('.scrollable-buttons-container')).overflowY==='auto','candidate button desktop layout');
    a.click();const result=await single;check(result.pipe==='<b>A</b>'&&!result.isAborted&&!result.isError,'candidate real single selection returns label');
    const multiple=executeSlashCommandsWithOptions('/buttons multiple=true labels=["A","B","C"] PACKAGED_SLASH_MULTIPLE',options);
    await wait(()=>find('PACKAGED_SLASH_MULTIPLE'),'candidate original buttons multiple');const next=find('PACKAGED_SLASH_MULTIPLE'),buttons=next.content.querySelectorAll('[data-toggle-value]');
    const unticked=getComputedStyle(buttons[1],'::before').content;
    buttons[1].click();buttons[0].click();buttons[2].click();buttons[2].click();
    check(buttons[1].classList.contains('toggled')&&buttons[0].classList.contains('toggled')&&!buttons[2].classList.contains('toggled')&&getComputedStyle(buttons[1],'::before').content!==unticked,'candidate click toggles actual visible choice marker');
    next.okButton.click();const selected=await multiple;
    check(selected.pipe==='["B","A"]'&&!selected.isAborted&&!selected.isError,'candidate actual selection order and JSON pipe');
    check(!first.dlg.isConnected&&!next.dlg.isConnected&&JSON.stringify(core.getContext().chat)===before,'candidate button dialogs disposed without accepted chat mutation');
    return{singlePipe:result.pipe,multiplePipe:selected.pipe,nativeModal:true,visibleChoiceState:true,dialogsDisposed:true};
  `,
};
