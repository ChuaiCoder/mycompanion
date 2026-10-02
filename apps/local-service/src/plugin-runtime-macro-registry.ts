// The shared AGPL parser/registry is reused in the host and extension document.
// Zero-argument additions also remain available to existing legacy profiles.
export const macroRegistrySource = String.raw`
import {MacroRegistry as registry,MacroEngine} from '/plugin-runtime/vendor/macro-engine.js';
import {MacrosParser} from '/plugin-runtime/macros.js';
export {MacroCategory,MacroValueType} from '/plugin-runtime/vendor/macro-engine.js';
// The outer legacy pass owns postprocessing. Keep its complete invocation
// environment (including one-shot original and nonce) without applying it twice.
const bridge = name => MacrosParser.registerLegacyMacro(name,(_nonce,env)=>MacroEngine.evaluate('{{'+name+'}}',{
  ...env,functions:{...env.functions,postProcess:value=>value},
}));
export const MacroRegistry = new Proxy(registry,{
  get(target,key){
    if(key==='registerMacro')return (name,options)=>{
      const definition=target.registerMacro(name,options);
      if(definition && definition.maxArgs===0 && !definition.list){bridge(name);for(const alias of definition.aliases)bridge(alias.alias);}
      return definition;
    };
    if(key==='registerMacroAlias')return (targetName,name,options)=>{
      const result=target.registerMacroAlias(targetName,name,options);
      const definition=target.getMacro(name);
      if(result && definition.maxArgs===0 && !definition.list)bridge(name);
      return result;
    };
    if(key==='unregisterMacro')return name=>{const exists=target.hasMacro(name);MacrosParser.unregisterMacro(name);return exists;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  },
});
`;
