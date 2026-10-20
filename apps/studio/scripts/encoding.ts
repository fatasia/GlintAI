export const ENCODING_PROFILES = {
  draft: { crf: 24, x264Preset: "veryfast", audioBitrate: "96k" },
  compact: { crf: 24, x264Preset: "slow", audioBitrate: "96k" },
  balanced: { crf: 20, x264Preset: "slow", audioBitrate: "128k" },
  quality: { crf: 16, x264Preset: "slow", audioBitrate: "192k" },
} as const;

export type EncodingProfile = keyof typeof ENCODING_PROFILES;

export function encodingOptions(profile: string = "balanced") {
  if (!Object.hasOwn(ENCODING_PROFILES, profile)) {
    throw new Error("encoding must be draft, compact, balanced or quality");
  }
  return ENCODING_PROFILES[profile as EncodingProfile];
}
