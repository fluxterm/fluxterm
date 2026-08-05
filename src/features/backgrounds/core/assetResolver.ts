import { getBuiltinWallpaperByAsset } from "@/constants/builtinWallpapers";
import { readBackgroundAsset } from "@/features/backgrounds/core/commands";

/** 背景媒体解析结果。 */
export type ResolvedBackgroundAsset = {
  url: string;
  revoke: () => void;
};

/** 将背景资产解析为浏览器可用的 URL。 */
export async function resolveBackgroundAssetUrl(
  asset: string,
): Promise<ResolvedBackgroundAsset> {
  const builtinWallpaper = getBuiltinWallpaperByAsset(asset);
  if (builtinWallpaper) {
    const builtinUrl = new URL(
      builtinWallpaper.url,
      window.location.href,
    ).toString();
    return {
      url: builtinUrl,
      revoke: () => {},
    };
  }

  const bytes = await readBackgroundAsset(asset);
  const blobUrl = URL.createObjectURL(new Blob([bytes]));
  return {
    url: blobUrl,
    revoke: () => {
      URL.revokeObjectURL(blobUrl);
    },
  };
}
