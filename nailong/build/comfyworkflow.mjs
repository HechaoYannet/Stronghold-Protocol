// nailong/build/comfyworkflow.mjs — Qwen-Image 2.1 图像编辑工作流（ComfyUI API 格式）。
//
// 节点组合**照抄本机官方模板** user\default\workflows\image_qwen_image_2_1_image_edit.json
// 里那个叫「Image Edit (Qwen Image 2.1)」的 subgraph —— 也就是这台机器上已经跑通过一次的图。
// 不自己发明连接方式。
//
// 关键结构（来自模板实证）：
//   TextEncodeQwenImage21 有 3 个输出 = [正向 CONDITIONING, 负向 CONDITIONING, 输入图的 LATENT]
//   ComfySwitchNode 在两者间切：on_false←图 latent（编辑模式，默认） / on_true←EmptyLatentImage（纯文生图）
//   KSampler: steps=25, cfg=1, euler/simple, denoise=1
//   输出分辨率跟随输入图的 latent → **宽高比天然保持**，正好和 imgops composite 对齐
//
// 本机模型（D:\Comfy-Desktop\ComfyUI-Shared\models，已下载，无需再下）：
//   diffusion_models\qwen_image_2.1_int8_convrot.safetensors
//   text_encoders\qwen3vl_8b_int8_convrot.safetensors
//   vae\qwen_image_2.1_vae_bf16.safetensors

export const MODELS = Object.freeze({
  diffusion: 'qwen_image_2.1_int8_convrot.safetensors',
  textEncoder: 'qwen3vl_8b_int8_convrot.safetensors',
  vae: 'qwen_image_2.1_vae_bf16.safetensors',
});

/**
 * 组装「图像编辑」工作流。
 * @param {{
 *   inputImage: string,        // LoadImage 用的文件名（由 comfyui.uploadImage 上传得到）
 *   refImages?: string[],      // 额外参考图，最多 2 张（image_2 / image_3）
 *   prompt: string,
 *   negativePrompt?: string,
 *   resolution?: number,       // 总像素预算，默认 1024（官方默认）
 *   steps?: number, cfg?: number, seed?: number, denoise?: number,
 *   sampler?: string, scheduler?: string,
 *   filenamePrefix?: string,
 * }} o
 */
export function buildEditWorkflow(o) {
  const refs = (o.refImages ?? []).filter(Boolean).slice(0, 2);
  const resolution = o.resolution ?? 1024;
  const steps = o.steps ?? 25;
  const cfg = o.cfg ?? 1;
  const seed = o.seed ?? 0;
  const denoise = o.denoise ?? 1;
  const sampler = o.sampler ?? 'euler';
  const scheduler = o.scheduler ?? 'simple';

  // images.image_1 = 底图，image_2/3 = 参考图（顺序即语义：模型用 <image1> <image2> 指代）
  const images = { 'images.image_1': ['4', 0] };
  refs.forEach((_, i) => { images['images.image_' + (i + 2)] = [String(5 + i), 0]; });

  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: MODELS.diffusion, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: MODELS.textEncoder, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: MODELS.vae } },
    4: { class_type: 'LoadImage', inputs: { image: o.inputImage } },
    6: { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    7: {
      class_type: 'TextEncodeQwenImage21',
      inputs: {
        clip: ['2', 0], vae: ['3', 0],
        prompt: o.prompt,
        negative_prompt: o.negativePrompt ?? '',
        resolution,
        ...images,
      },
    },
    8: { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    9: { class_type: 'ComfySwitchNode', inputs: { on_false: ['7', 2], on_true: ['8', 0], switch: false } },
    10: {
      class_type: 'KSampler',
      inputs: {
        model: ['6', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['9', 0],
        seed, steps, cfg, sampler_name: sampler, scheduler, denoise,
      },
    },
    11: { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } },
    12: { class_type: 'SaveImage', inputs: { images: ['11', 0], filename_prefix: o.filenamePrefix ?? 'nailong' } },
  };
  refs.forEach((name, i) => {
    wf[5 + i] = { class_type: 'LoadImage', inputs: { image: name } };
  });
  return wf;
}

/** 纯文生图（switch=true → 走 EmptyLatentImage）。用于生成/扩充奶龙的原创参考图。 */
export function buildText2ImageWorkflow(o) {
  const wf = buildEditWorkflow({ ...o, inputImage: o.inputImage ?? '', refImages: [] });
  delete wf[4];
  delete wf[7].inputs['images.image_1'];
  wf[9].inputs = { on_false: ['7', 2], on_true: ['8', 0], switch: true };
  wf[8].inputs = { width: o.width ?? 1024, height: o.height ?? 1024, batch_size: 1 };
  return wf;
}
