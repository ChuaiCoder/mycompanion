// @ts-nocheck -- readable fixed-upstream JavaScript, host adapters below.
/*! SillyTavern 1.19.0, 7e8663cd9c184a550b37238218bdd32c6efc68e9, AGPL-3.0-only.
 * See world-info-vector-upstream.json and THIRD_PARTY_NOTICES.md. */
export function createWorldInfoVectorRuntime(deps: any): any {
  const settings=deps.settings, console=deps.console??{debug(){},log(){}};
  const getSortedEntries=deps.getSortedEntries,getSavedHashes=deps.getSavedHashes;
  const insertVectorItems=deps.insertVectorItems,deleteVectorItems=deps.deleteVectorItems;
  const queryMultipleCollections=deps.queryMultipleCollections,getStringHash=deps.getStringHash;
  const substituteParams=deps.substituteParams,collapseNewlines=deps.collapseNewlines;
  const onlyUnique=(value,index,array)=>array.indexOf(value)===index;
  const event_types={WORLDINFO_FORCE_ACTIVATE:'worldinfo_force_activate'};
  const eventSource={emit:(_type,entries)=>deps.forceActivate(entries)};
  const summarize=deps.summarize;
  async function getQueryText(chat, initiator) {
    const getTextWithoutAttachments = (x) => {
        const fileLength = x?.extra?.fileLength || 0;
        return String(x?.mes || '').substring(fileLength).trim();
    };

    let hashedMessages = chat
        .map(x => ({ text: substituteParams(getTextWithoutAttachments(x)), hash: getStringHash(substituteParams(getTextWithoutAttachments(x))), index: chat.indexOf(x) }))
        .filter(x => x.text)
        .reverse()
        .slice(0, settings.query);

    if (initiator === 'chat' && settings.enabled_chats && settings.summarize && settings.summarize_sent) {
        const minLength = Math.max(0, Number(settings.summary_threshold) || 0);
        const toSummarize = minLength > 0 ? hashedMessages.filter(x => x.text.length >= minLength) : hashedMessages;
        if (toSummarize.length > 0) {
            await summarize(toSummarize, settings.summary_source, { skipOnFailure: true });
        }
    }

    const queryText = hashedMessages.map(x => x.text).join('\n');

    return collapseNewlines(queryText).trim();
}
  async function activateWorldInfo(chat) {
    if (!settings.enabled_world_info) {
        console.debug('Vectors: Disabled for World Info');
        return;
    }

    const entries = await getSortedEntries();

    if (!Array.isArray(entries) || entries.length === 0) {
        console.debug('Vectors: No WI entries found');
        return;
    }

    // Group entries by "world" field
    const groupedEntries = {};

    for (const entry of entries) {
        // Skip orphaned entries. Is it even possible?
        if (!entry.world) {
            console.debug('Vectors: Skipped orphaned WI entry', entry);
            continue;
        }

        // Skip disabled entries
        if (entry.disable) {
            console.debug('Vectors: Skipped disabled WI entry', entry);
            continue;
        }

        // Skip entries without content
        if (!entry.content) {
            console.debug('Vectors: Skipped WI entry without content', entry);
            continue;
        }

        // Skip non-vectorized entries
        if (!entry.vectorized && !settings.enabled_for_all) {
            console.debug('Vectors: Skipped non-vectorized WI entry', entry);
            continue;
        }

        if (!Object.hasOwn(groupedEntries, entry.world)) {
            groupedEntries[entry.world] = [];
        }

        groupedEntries[entry.world].push(entry);
    }

    const collectionIds = [];

    if (Object.keys(groupedEntries).length === 0) {
        console.debug('Vectors: No WI entries to synchronize');
        return;
    }

    // Synchronize collections
    for (const world in groupedEntries) {
        const collectionId = `world_${getStringHash(world)}`;
        const hashesInCollection = await getSavedHashes(collectionId);
        const newEntries = groupedEntries[world].filter(x => !hashesInCollection.includes(getStringHash(x.content)));
        const deletedHashes = hashesInCollection.filter(x => !groupedEntries[world].some(y => getStringHash(y.content) === x));

        if (newEntries.length > 0) {
            console.log(`Vectors: Found ${newEntries.length} new WI entries for world ${world}`);
            await insertVectorItems(collectionId, newEntries.map(x => ({ hash: getStringHash(x.content), text: x.content, index: x.uid })));
        }

        if (deletedHashes.length > 0) {
            console.log(`Vectors: Deleted ${deletedHashes.length} old hashes for world ${world}`);
            await deleteVectorItems(collectionId, deletedHashes);
        }

        collectionIds.push(collectionId);
    }

    // Perform a multi-query
    const queryText = deps.queryText ?? await getQueryText(chat, 'world-info');

    if (queryText.length === 0) {
        console.debug('Vectors: No text to query for WI');
        return;
    }

    const queryResults = await queryMultipleCollections(collectionIds, queryText, settings.max_entries, settings.score_threshold);
    const activatedHashes = Object.values(queryResults).flatMap(x => x.hashes).filter(onlyUnique);
    const activatedEntries = [];

    // Activate entries found in the query results
    for (const entry of entries) {
        const hash = getStringHash(entry.content);

        if (activatedHashes.includes(hash)) {
            activatedEntries.push(entry);
        }
    }

    if (activatedEntries.length === 0) {
        console.debug('Vectors: No activated WI entries found');
        return;
    }

    console.log(`Vectors: Activated ${activatedEntries.length} WI entries`, activatedEntries);
    await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, activatedEntries);
}
  return {getQueryText,activateWorldInfo};
}
export function createVectorMultiQuery(deps: any): any {
  const getVector=(_source,_settings,text,_isQuery,_directories)=>deps.getVector(text);
  const getIndex=(_directories,id,_source,_settings)=>deps.getIndex(id);
  async function multiQueryCollection(directories, collectionIds, source, sourceSettings, searchText, topK, threshold) {
    const vector = await getVector(source, sourceSettings, searchText, true, directories);
    const results = [];

    for (const collectionId of collectionIds) {
        const store = await getIndex(directories, collectionId, source, sourceSettings);
        const result = await store.queryItems(vector, topK);
        results.push(...result.map(result => ({ collectionId, result })));
    }

    // Sort results by descending similarity, apply threshold, and take top K
    const sortedResults = results
        .sort((a, b) => b.result.score - a.result.score)
        .filter(x => x.result.score >= threshold)
        .slice(0, topK);

    /**
     * Group the results by collection ID
     * @type {Record<string, { hashes: number[], metadata: object[] }>}
     */
    const groupedResults = {};
    for (const result of sortedResults) {
        if (!groupedResults[result.collectionId]) {
            groupedResults[result.collectionId] = { hashes: [], metadata: [] };
        }

        groupedResults[result.collectionId].hashes.push(Number(result.result.item.metadata.hash));
        groupedResults[result.collectionId].metadata.push(result.result.item.metadata);
    }

    return groupedResults;
}
  return (collectionIds,searchText,topK,threshold)=>multiQueryCollection(null,collectionIds,null,null,searchText,topK,threshold);
}
