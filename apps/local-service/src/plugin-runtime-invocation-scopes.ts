// Async draft scopes release before a host navigation changes the real objects.
export const invocationScopesBrowserSource = String.raw`
const active=new Set();
export function beginInvocationScope(target,restore) {
  const controller=new AbortController();let finished=false;
  const scope={target,controller,leave(reason){if(finished)return;finished=true;active.delete(scope);restore();if(reason)controller.abort(reason);}};
  active.add(scope);return scope;
}
export function cancelInvocationScopesForContext(next,current) {
  const conversationId=Object.hasOwn(next,'conversationId')?next.conversationId:current.conversationId;
  const branchId=Object.hasOwn(next,'branchId')?next.branchId:current.branchId;
  for(const scope of [...active])if((conversationId??null)!==scope.target.conversationId||(branchId??null)!==scope.target.branchId)
    scope.leave(new Error('故事已切换，已取消旧请求的扩展执行。'));
}
`;
