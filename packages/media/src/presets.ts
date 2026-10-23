/** Prompt presets shared by the CLI image editor and the web workshop. */
export const IMAGE_EDIT_PRESETS: Record<string, string> = {
  "remove-bg": "去除背景,仅保留主体,背景替换为纯白色",
  "new-background": "保持主体与文字完全不变,将背景替换为干净的纯色渐变背景",
  retouch: "商品级精修:校正光影与白平衡,去除噪点,保持细节与文字真实不变形",
  restore: "修复老照片:去除划痕与噪点,恢复自然色彩与细节",
  upscale: "提升清晰度与细节,保持原始构图与内容不变",
  "product-polish": "电商商品图精修:保持商品结构、商标、包装与文字准确,清理灰尘,校正材质反光,使用自然棚拍光线和干净背景",
  "model-swap": "更换为成年电商模特,保持服装款式、纹理、图案、配饰与商品本身完全不变,姿态与透视自然,不要修改品牌文字",
  "remove-object": "移除选区内的多余物体,以周围背景自然填充,保持选区之外内容不变",
};
