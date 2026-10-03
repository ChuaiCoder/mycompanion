import { runInNewContext } from "node:vm";
import { expect,it,vi } from "vitest";
import { mergeJsonChanges, mergeChatMessages, toExtensionMessage } from "@mycompanion/shared";
import { chatPersistenceSource } from "./plugin-runtime-chat.js";

it("keeps same-story variable references through host snapshots and branch changes, then detaches them on a story change",()=>{
  const source=chatPersistenceSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
  const api=runInNewContext(source+"\n;({bindChatContext,applyChatContext})",{mergeJsonChanges,mergeChatMessages,toExtensionMessage,isMacroDraftActive:()=>false});
  const nested={count:1},list=[1,2],local={count:1,nested,list},metadata={variables:local};
  const context={conversationId:"story-a",branchId:"branch-a",chat:[],chatMetadata:metadata};api.bindChatContext(context);
  api.applyChatContext({conversationId:"story-a",branchId:"branch-a",chat:[],chatMetadata:{variables:{count:2,nested:{count:2},list:[3]}}});
  expect(context.chatMetadata).toBe(metadata);expect(context.chatMetadata.variables).toBe(local);expect(local.nested).toBe(nested);expect(local.list).toBe(list);
  expect(local).toEqual({count:2,nested:{count:2},list:[3]});
  // The host assigns IDs after its persistence merge, as applyHostContext does.
  api.applyChatContext({conversationId:"story-a",branchId:"branch-b",chat:[],chatMetadata:{variables:{count:3,nested:{count:3},list:[4,5]}}});
  context.branchId="branch-b";expect(context.chatMetadata.variables).toBe(local);expect(local).toEqual({count:3,nested:{count:3},list:[4,5]});
  api.applyChatContext({conversationId:"story-b",branchId:"branch-c",chat:[],chatMetadata:{variables:{count:9}}});
  context.conversationId="story-b";expect(context.chatMetadata).toBe(metadata);expect(context.chatMetadata.variables).not.toBe(local);
  expect(local).toEqual({count:3,nested:{count:3},list:[4,5]});expect(context.chatMetadata.variables).toEqual({count:9});
});

it("applies accepted world-info state in place only to the current story and branch",()=>{
  const source=chatPersistenceSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
  const api=runInNewContext(source+"\n;({bindChatContext,applyChatContext,connectChatPersistence,applyWorldInfoState})",{mergeJsonChanges,mergeChatMessages,toExtensionMessage,isMacroDraftActive:()=>false});
  const sticky={},timed={sticky},metadata={timedWorldInfo:timed};
  const context={conversationId:"story-a",branchId:"branch-a",chat:[],chatMetadata:metadata};api.bindChatContext(context);
  api.applyChatContext({chat:[],chatMetadata:metadata});
  const syncMetadata=vi.fn();api.connectChatPersistence({syncMetadata});
  const next={timedWorldInfo:{sticky:{entry:{start:1,end:4}}},__mycompanion_world_info_state:{version:1,revision:1}};
  expect(api.applyWorldInfoState({conversationId:"story-a",branchId:"branch-b"},next)).toBe(false);
  expect(syncMetadata).not.toHaveBeenCalled();expect(timed).toEqual({sticky:{}});
  expect(api.applyWorldInfoState({conversationId:"story-a",branchId:"branch-a"},next)).toBe(true);
  expect(context.chatMetadata.timedWorldInfo).toBe(timed);expect(timed.sticky).toBe(sticky);expect(sticky).toEqual({entry:{start:1,end:4}});
  expect(syncMetadata).toHaveBeenCalledWith("story-a",{...next});
  // A stale unchanged host snapshot must not erase the accepted state.
  api.applyChatContext({chat:[],chatMetadata:{timedWorldInfo:{sticky:{}}}});
  expect(context.chatMetadata.timedWorldInfo).toEqual(next.timedWorldInfo);
});

it("retains an empty canonical variable map when a same-story branch snapshot omits variables",()=>{
  const source=chatPersistenceSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
  const api=runInNewContext(source+"\n;({bindChatContext,applyChatContext})",{mergeJsonChanges,mergeChatMessages,toExtensionMessage,isMacroDraftActive:()=>false});
  const local={count:1},metadata={variables:local};
  const context={conversationId:"story-a",branchId:"branch-a",chat:[],chatMetadata:metadata};api.bindChatContext(context);
  api.applyChatContext({conversationId:"story-a",branchId:"branch-a",chat:[],chatMetadata:{variables:{count:1}}});
  api.applyChatContext({conversationId:"story-a",branchId:"branch-b",chat:[],chatMetadata:{}});
  context.branchId="branch-b";
  expect(context.chatMetadata.variables).toBe(local);expect(local).toEqual({});
  api.applyChatContext({conversationId:"story-a",branchId:"branch-b",chat:[],chatMetadata:{variables:{count:2}}});
  expect(context.chatMetadata.variables).toBe(local);expect(local).toEqual({count:2});
});

it("keeps default reload failures observable and explicitly reconciles an optimistic failed save from durable state", async () => {
  const source=chatPersistenceSource.replace(/^import .*;\r?\n/gm,"").replace(/^export /gm,"");
  const render=vi.fn(), changed=vi.fn(), local={retained:1};
  const context={conversationId:"story-a",branchId:"branch-a",chat:[{id:"message",mes:"durable",is_user:false}],chatMetadata:{variables:local}};
  const durable={id:"story-a",activeBranchId:"branch-a",characterName:"Role",messages:[{id:"message",role:"assistant",content:"durable",createdAt:"2026-10-03"}],chatMetadata:{variables:{retained:1}}};
  const fetch=vi.fn().mockResolvedValueOnce({ok:false,status:503,json:async()=>({error:{message:"Actual failed write"}})})
    .mockResolvedValueOnce({ok:true,json:async()=>durable});
  const api=runInNewContext(source+"\n;({bindChatContext,applyChatContext,connectChatPersistence,saveChatConditional,reloadCurrentChat,flushChatSaves})",{
    mergeJsonChanges,mergeChatMessages,toExtensionMessage,isMacroDraftActive:()=>false,fetch,clearTimeout,setTimeout,crypto:{randomUUID:()=>"fixture-id"},
  });
  api.bindChatContext(context);api.applyChatContext({chat:context.chat,chatMetadata:context.chatMetadata});api.connectChatPersistence({render,changed});
  context.chat[0]!.mes="optimistic";
  await expect(api.saveChatConditional()).rejects.toThrow("Actual failed write");
  await expect(api.reloadCurrentChat()).rejects.toThrow("Actual failed write");expect(fetch).toHaveBeenCalledTimes(1);
  await api.reloadCurrentChat({discardFailedSaves:true});
  expect(context.chat[0]!.mes).toBe("durable");expect(context.chatMetadata.variables).toBe(local);
  expect(render).toHaveBeenCalledOnce();expect(changed).toHaveBeenCalledWith("story-a");await expect(api.flushChatSaves()).resolves.toBeUndefined();
});
