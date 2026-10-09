import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "../i18n";
import type { ModelResponseState } from "@mycompanion/shared";
import { decodeModelMedia } from "../model-media";

function MediaItem({ parts, index }: { parts: ModelResponseState["media"]; index: number }) {
  const media = parts[0]!;
  const { t } = useTranslation();
  const [url, setUrl] = useState(""), [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl = "";
    setFailed(false); setUrl("");
    try { const decoded = decodeModelMedia(media, parts.map(part => part.data)); objectUrl = URL.createObjectURL(new Blob([decoded.bytes], { type: decoded.mimeType })); setUrl(objectUrl); }
    catch { setFailed(true); }
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [parts]);
  const image = /^image\//i.test(media.mimeType), audio = /^audio\//i.test(media.mimeType);
  return <figure className="model-media-item" data-model-media={index}>
    {url && image ? <img src={url} alt={t("模型生成图片 {{index}}", { index: index + 1 })} loading="lazy" onError={() => setFailed(true)} /> : null}
    {url && audio ? <audio src={url} controls preload="metadata" aria-label={t("模型生成音频 {{index}}", { index: index + 1 })} onError={() => setFailed(true)} /> : null}
    {failed ? <p role="status">{t("此媒体暂时无法解码或播放。")}</p> : null}
    {url ? <figcaption><a href={url} download={`model-media-${index + 1}`}>{t("保存媒体")}</a><small>{media.mimeType}</small></figcaption> : null}
  </figure>;
}
export function ModelMedia({ media }: { media?: ModelResponseState["media"] | undefined }) {
  const groups = useMemo(() => {
    const result: ModelResponseState["media"][] = [];
    for (const item of media ?? []) {
      const previous = result.at(-1);
      // Raw PCM and compressed MP3 parts can represent one streaming output.
      // Self-contained WAV/images remain separate media artifacts.
      if (/^audio\/(?:pcm|l16|mpeg)(?:;|$)/i.test(item.mimeType) && previous?.[0]?.mimeType === item.mimeType) previous.push(item);
      else result.push([item]);
    }
    return result;
  }, [media]);
  if (!media?.length) return null;
  return <div className="model-media">{groups.map((parts, index) => <MediaItem key={index} parts={parts} index={index} />)}</div>;
}
