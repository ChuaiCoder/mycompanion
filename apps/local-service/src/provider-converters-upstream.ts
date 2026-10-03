// @ts-nocheck -- unchanged checksum-fixed upstream declarations; typed host boundary.
// SPDX-License-Identifier: AGPL-3.0-only
// SillyTavern 7e8663cd9c184a550b37238218bdd32c6efc68e9, src/prompt-converters.js.
// Regenerate/check with scripts/import-provider-converters.mjs; no upstream service is embedded.
const PROMPT_PLACEHOLDER = "Let's get started.";
const REASONING_EFFORT={auto:'auto',low:'low',medium:'medium',high:'high',min:'min',max:'max'};
const GEMINI_MEDIA_RESOLUTION={low:'media_resolution_low',high:'media_resolution_high'};
const enableThoughtSignatures=true;
const tryParse=value=>{try{return JSON.parse(value);}catch{return null;}};

export function convertClaudeMessages(messages, prefillString, useSysPrompt, useTools, names) {
    let systemPrompt = [];
    if (useSysPrompt) {
        // Collect all the system messages up until the first instance of a non-system message, and then remove them from the messages array.
        let i;
        for (i = 0; i < messages.length; i++) {
            if (messages[i].role !== 'system') {
                break;
            }
            // Append example names if not already done by the frontend (e.g. for group chats).
            if (names.userName && messages[i].name === 'example_user') {
                if (!messages[i].content.startsWith(`${names.userName}: `)) {
                    messages[i].content = `${names.userName}: ${messages[i].content}`;
                }
            }
            if (names.charName && messages[i].name === 'example_assistant') {
                if (!messages[i].content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(messages[i].content)) {
                    messages[i].content = `${names.charName}: ${messages[i].content}`;
                }
            }
            systemPrompt.push({ type: 'text', text: messages[i].content });
        }

        messages.splice(0, i);

        // Check if the first message in the array is of type user, if not, interject with humanMsgFix or a blank message.
        // Also prevents erroring out if the messages array is empty.
        if (messages.length === 0) {
            messages.unshift({
                role: 'user',
                content: PROMPT_PLACEHOLDER,
            });
        }
    }

    // Now replace all further messages that have the role 'system' with the role 'user'. (or all if we're not using one)
    const parse = (str) => typeof str === 'string' ? JSON.parse(str) : str;
    messages.forEach((message) => {
        if (message.role === 'assistant' && message.tool_calls) {
            message.content = message.tool_calls.map((tc) => ({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: parse(tc.function.arguments),
            }));
        }

        if (message.role === 'tool') {
            message.role = 'user';
            message.content = [{
                type: 'tool_result',
                tool_use_id: message.tool_call_id,
                content: message.content,
            }];
        }

        if (message.role === 'system') {
            if (names.userName && message.name === 'example_user') {
                if (!message.content.startsWith(`${names.userName}: `)) {
                    message.content = `${names.userName}: ${message.content}`;
                }
            }
            if (names.charName && message.name === 'example_assistant') {
                if (!message.content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(message.content)) {
                    message.content = `${names.charName}: ${message.content}`;
                }
            }
            message.role = 'user';

            // Delete name here so it doesn't get added later
            delete message.name;
        }

        // Convert everything to an array of it would be easier to work with
        if (typeof message.content === 'string') {
            // Take care of name properties since claude messages don't support them
            if (message.name) {
                message.content = `${message.name}: ${message.content}`;
            }

            message.content = [{ type: 'text', text: message.content }];
        } else if (Array.isArray(message.content)) {
            message.content = message.content.map((content) => {
                if (content.type === 'image_url') {
                    const imageEntry = content?.image_url;
                    const imageData = imageEntry?.url;
                    const mimeType = imageData?.split(';')?.[0].split(':')?.[1];
                    const base64Data = imageData?.split(',')?.[1];

                    return {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: mimeType,
                            data: base64Data,
                        },
                    };
                }

                if (content.type === 'text') {
                    if (message.name) {
                        content.text = `${message.name}: ${content.text}`;
                    }

                    // If the text is empty, replace it with a zero-width space
                    return { type: 'text', text: content.text || '\u200b' };
                }

                return content;
            });
        }

        // Remove offending properties
        delete message.name;
        delete message.tool_calls;
        delete message.tool_call_id;
    });

    // Images in assistant messages should be moved to the next user message
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].role === 'assistant' && messages[i].content.some(c => c.type === 'image')) {
            // Find the next user message
            let j = i + 1;
            while (j < messages.length && messages[j].role !== 'user') {
                j++;
            }

            // Move the images
            if (j >= messages.length) {
                // If there is no user message after the assistant message, add a new one
                messages.splice(i + 1, 0, { role: 'user', content: [] });
            }

            messages[j].content.push(...messages[i].content.filter(c => c.type === 'image'));
            messages[i].content = messages[i].content.filter(c => c.type !== 'image');
        }
    }

    // Shouldn't be conditional anymore, messages api expects the last role to be user unless we're explicitly prefilling
    if (prefillString) {
        messages.push({
            role: 'assistant',
            // Dangling whitespace are not allowed for prefilling
            content: [{ type: 'text', text: prefillString.trimEnd() }],
        });
    }

    // Since the messaging endpoint only supports user assistant roles in turns, we have to merge messages with the same role if they follow eachother
    // Also handle multi-modality, holy slop.
    let mergedMessages = [];
    messages.forEach((message) => {
        if (mergedMessages.length > 0 && mergedMessages[mergedMessages.length - 1].role === message.role) {
            mergedMessages[mergedMessages.length - 1].content.push(...message.content);
        } else {
            mergedMessages.push(message);
        }
    });

    if (!useTools) {
        mergedMessages.forEach((message) => {
            message.content.forEach((content) => {
                if (content.type === 'tool_use') {
                    content.type = 'text';
                    content.text = JSON.stringify(content.input);
                    delete content.id;
                    delete content.name;
                    delete content.input;
                }
                if (content.type === 'tool_result') {
                    content.type = 'text';
                    content.text = content.content;
                    delete content.tool_use_id;
                    delete content.content;
                }
            });
        });
    }

    return { messages: mergedMessages, systemPrompt: systemPrompt };
}

export function convertGooglePrompt(messages, model, useSysPrompt, names) {
    const sysPrompt = [];

    if (useSysPrompt) {
        while (messages.length > 1 && messages[0].role === 'system') {
            // Append example names if not already done by the frontend (e.g. for group chats).
            if (names.userName && messages[0].name === 'example_user') {
                if (!messages[0].content.startsWith(`${names.userName}: `)) {
                    messages[0].content = `${names.userName}: ${messages[0].content}`;
                }
            }
            if (names.charName && messages[0].name === 'example_assistant') {
                if (!messages[0].content.startsWith(`${names.charName}: `) && !names.startsWithGroupName(messages[0].content)) {
                    messages[0].content = `${names.charName}: ${messages[0].content}`;
                }
            }
            sysPrompt.push(messages[0].content);
            messages.shift();
        }
    }

    const system_instruction = { parts: sysPrompt.map(text => ({ text })) };
    const toolNameMap = {};

    // https://ai.google.dev/gemini-api/docs/latest-model#prefilled-model-turn-validation
    const noPrefillModel = /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/.test(model);

    const contents = [];
    messages.forEach((message, index) => {
        // fix the roles
        if (message.role === 'system' || message.role === 'tool') {
            message.role = 'user';
        } else if (message.role === 'assistant') {
            // A trailing model turn is a prefill, which is rejected by the newest models
            message.role = noPrefillModel && index === messages.length - 1 ? 'user' : 'model';
        }

        // Convert the content to an array of parts
        if (!Array.isArray(message.content)) {
            const content = (() => {
                const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
                const hasToolCallId = typeof message.tool_call_id === 'string' && message.tool_call_id.length > 0;

                if (hasToolCalls) {
                    return { type: 'tool_calls', tool_calls: message.tool_calls };
                }

                if (hasToolCallId) {
                    return { type: 'tool_call_id', tool_call_id: message.tool_call_id, content: String(message.content ?? '') };
                }

                return { type: 'text', text: String(message.content ?? '') };
            })();
            message.content = [content];
        }

        // similar story as claude
        if (message.name) {
            message.content.forEach((part) => {
                if (part.type !== 'text') {
                    return;
                }
                if (message.name === 'example_user') {
                    if (names.userName && !part.text.startsWith(`${names.userName}: `)) {
                        part.text = `${names.userName}: ${part.text}`;
                    }
                } else if (message.name === 'example_assistant') {
                    if (names.charName && !part.text.startsWith(`${names.charName}: `) && !names.startsWithGroupName(part.text)) {
                        part.text = `${names.charName}: ${part.text}`;
                    }
                } else {
                    if (!part.text.startsWith(`${message.name}: `)) {
                        part.text = `${message.name}: ${part.text}`;
                    }
                }
            });

            delete message.name;
        }

        //create the prompt parts
        const parts = [];
        message.content.forEach((part) => {
            const addDataUrlPart = (/** @type {string} */ url, /** @type {string} */ defaultMimeType, /** @type {string?} */ detail = null) => {
                if (url && url.startsWith('data:')) {
                    const [header, base64Data] = url.split(',');
                    const mimeType = header.match(/data:([^;]+)/)?.[1] || defaultMimeType;
                    const mediaResolution = GEMINI_MEDIA_RESOLUTION[detail] || null;

                    const part = {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data,
                        },
                    };

                    // https://ai.google.dev/gemini-api/docs/gemini-3#media_resolution
                    if (/gemini-3/.test(model) && mediaResolution) {
                        part.mediaResolution = {
                            level: mediaResolution,
                        };
                    }

                    parts.push(part);
                }
            };

            if (part.type === 'text') {
                parts.push({ text: part.text });
            } else if (part.type === 'provider_native') {
                parts.push(part.part);
            } else if (part.type === 'tool_call_id') {
                const name = toolNameMap[part.tool_call_id] ?? 'unknown';
                parts.push({
                    functionResponse: {
                        name: name,
                        response: { name: name, content: part.content },
                    },
                });
            } else if (part.type === 'tool_calls') {
                part.tool_calls.forEach((toolCall) => {
                    parts.push({
                        functionCall: {
                            name: toolCall.function.name,
                            args: tryParse(toolCall.function.arguments) ?? toolCall.function.arguments,
                        },
                        ...(toolCall.signature ? { thoughtSignature: toolCall.signature } : {}),
                    });

                    toolNameMap[toolCall.id] = toolCall.function.name;
                });
            } else if (part.type === 'image_url') {
                const imageUrl = part.image_url?.url;
                const detail = part.image_url?.detail;
                addDataUrlPart(imageUrl, 'image/png', detail);
            } else if (part.type === 'video_url') {
                const videoUrl = part.video_url?.url;
                const detail = part.video_url?.detail;
                addDataUrlPart(videoUrl, 'video/mp4', detail);
            } else if (part.type === 'audio_url') {
                const audioUrl = part.audio_url?.url;
                addDataUrlPart(audioUrl, 'audio/mpeg');
            }
        });

        // https://ai.google.dev/gemini-api/docs/gemini-3#migrating_from_other_models
        // Inject stored thought signatures, or fall back to bypass magic for Gemini 3
        if (/gemini-3/.test(model) || /gemini-2\.5/.test(model)) {
            const skipSignatureMagic = 'skip_thought_signature_validator';
            const textSignature = message.signature;

            parts.forEach((part) => {
                if (enableThoughtSignatures && textSignature && typeof part.text === 'string') {
                    part.thoughtSignature = textSignature;
                } else if (/gemini-3/.test(model)) {
                    // Gemini 3: Fall back to bypass magic for function calls (mandatory) and images
                    if (part.functionCall && !part.thoughtSignature) {
                        part.thoughtSignature = skipSignatureMagic;
                    }
                    if (/-image/.test(model) && message.role === 'model') {
                        if (typeof part.text === 'string' || part.inlineData) {
                            part.thoughtSignature = skipSignatureMagic;
                        }
                    }
                }
                // Gemini 2.5 without stored signatures: signatures are optional, no bypass needed
            });
        }

        // merge consecutive messages with the same role
        if (index > 0 && message.role === contents[contents.length - 1].role) {
            parts.forEach((part) => {
                if (part.text) {
                    const textPart = contents[contents.length - 1].parts.find(p => typeof p.text === 'string');
                    if (textPart) {
                        textPart.text += '\n\n' + part.text;
                    } else {
                        contents[contents.length - 1].parts.push(part);
                    }
                }
                if (part.inlineData || part.functionCall || part.functionResponse || part.thoughtSignature || part.mediaResolution) {
                    contents[contents.length - 1].parts.push(part);
                }
            });
        } else {
            contents.push({
                role: message.role,
                parts: parts,
            });
        }
    });

    return { contents: contents, system_instruction: system_instruction };
}

export function calculateClaudeBudgetTokens(maxTokens, reasoningEffort, stream, isAdaptiveModel) {
    // Adaptive thinking for Opus 4.6+: return effort string (like Gemini 3)
    if (isAdaptiveModel) {
        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return null;
            case REASONING_EFFORT.min:
                return 'low';
            case REASONING_EFFORT.low:
                return 'low';
            case REASONING_EFFORT.medium:
                return 'medium';
            case REASONING_EFFORT.high:
                return 'high';
            case REASONING_EFFORT.max:
                return 'max';
        }
        return null;
    }

    let budgetTokens = 0;

    switch (reasoningEffort) {
        case REASONING_EFFORT.auto:
            return null;
        case REASONING_EFFORT.min:
            budgetTokens = 1024;
            break;
        case REASONING_EFFORT.low:
            budgetTokens = Math.floor(maxTokens * 0.1);
            break;
        case REASONING_EFFORT.medium:
            budgetTokens = Math.floor(maxTokens * 0.25);
            break;
        case REASONING_EFFORT.high:
            budgetTokens = Math.floor(maxTokens * 0.5);
            break;
        case REASONING_EFFORT.max:
            budgetTokens = Math.floor(maxTokens * 0.95);
            break;
    }

    budgetTokens = Math.max(budgetTokens, 1024);

    if (!stream) {
        budgetTokens = Math.min(budgetTokens, 21333);
    }

    return budgetTokens;
}

export function calculateGoogleBudgetTokens(maxTokens, reasoningEffort, model) {
    function getFlashBudget() {
        let budgetTokens = 0;

        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return -1;
            case REASONING_EFFORT.min:
                return 0;
            case REASONING_EFFORT.low:
                budgetTokens = Math.floor(maxTokens * 0.1);
                break;
            case REASONING_EFFORT.medium:
                budgetTokens = Math.floor(maxTokens * 0.25);
                break;
            case REASONING_EFFORT.high:
                budgetTokens = Math.floor(maxTokens * 0.5);
                break;
            case REASONING_EFFORT.max:
                budgetTokens = maxTokens;
                break;
        }

        budgetTokens = Math.min(budgetTokens, 24576);

        return budgetTokens;
    }

    function getFlashLiteBudget() {
        let budgetTokens = 0;

        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return -1;
            case REASONING_EFFORT.min:
                return 0;
            case REASONING_EFFORT.low:
                budgetTokens = Math.floor(maxTokens * 0.1);
                break;
            case REASONING_EFFORT.medium:
                budgetTokens = Math.floor(maxTokens * 0.25);
                break;
            case REASONING_EFFORT.high:
                budgetTokens = Math.floor(maxTokens * 0.5);
                break;
            case REASONING_EFFORT.max:
                budgetTokens = maxTokens;
                break;
        }

        budgetTokens = Math.max(Math.min(budgetTokens, 24576), 512);

        return budgetTokens;
    }

    function getProBudget() {
        let budgetTokens = 0;

        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return -1;
            case REASONING_EFFORT.min:
                budgetTokens = 128;
                break;
            case REASONING_EFFORT.low:
                budgetTokens = Math.floor(maxTokens * 0.1);
                break;
            case REASONING_EFFORT.medium:
                budgetTokens = Math.floor(maxTokens * 0.25);
                break;
            case REASONING_EFFORT.high:
                budgetTokens = Math.floor(maxTokens * 0.5);
                break;
            case REASONING_EFFORT.max:
                budgetTokens = maxTokens;
                break;
        }

        budgetTokens = Math.max(Math.min(budgetTokens, 32768), 128);

        return budgetTokens;
    }

    function getGemini3FlashBudget() {
        // https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
        const noMinimalThinking = /gemini-3\.7-flash/.test(model);
        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return null;
            case REASONING_EFFORT.min:
                return noMinimalThinking ? 'low' : 'minimal';
            case REASONING_EFFORT.low:
                return 'low';
            case REASONING_EFFORT.medium:
                return 'medium';
            case REASONING_EFFORT.high:
                return 'high';
            case REASONING_EFFORT.max:
                return 'high';
        }

        return null;
    }

    function getGemini3ProBudget() {
        switch (reasoningEffort) {
            case REASONING_EFFORT.auto:
                return null;
            case REASONING_EFFORT.min:
                return 'low';
            case REASONING_EFFORT.low:
                return 'low';
            case REASONING_EFFORT.medium:
                return 'low';
            case REASONING_EFFORT.high:
                return 'high';
            case REASONING_EFFORT.max:
                return 'high';
        }

        return null;
    }

    if (/gemini-3[.\d]*-pro/.test(model)) {
        return getGemini3ProBudget();
    }

    if (/gemini-3[.\d]*-flash/.test(model)) {
        return getGemini3FlashBudget();
    }

    if (/flash-lite/.test(model)) {
        return getFlashLiteBudget();
    }

    if (/flash/.test(model)) {
        return getFlashBudget();
    }

    if (/pro/.test(model)) {
        return getProBudget();
    }

    return null;
}
