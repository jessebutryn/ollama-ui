#!/bin/sh
# Downloads model weights into /models. `image` (the default) fetches the image
# server (Z-Image-Turbo, ~10 GB, plus the ESRGAN upscalers) and the edit server
# (FLUX.2 klein 9B, ~17 GB); `video` fetches the video server (LTX-2.3 22B, ~28 GB).
# Files already present are skipped; interrupted downloads resume.
set -eu

HF=https://huggingface.co

fetch() {
  url=$1
  name=$2
  if [ -s "/models/$name" ]; then
    echo "Have $name"
    return
  fi
  echo "Downloading $name"
  curl -fL --retry 5 --retry-delay 5 -C - -o "/models/$name.part" "$url"
  mv "/models/$name.part" "/models/$name"
}

if [ "${1:-image}" = video ]; then
  # LTX-2.3 22B dev generates video with a matching audio track. Gemma 3 is its
  # text encoder; the embeddings connectors project Gemma's output for LTX.
  mkdir -p /models/ltx
  fetch "$HF/unsloth/LTX-2.3-GGUF/resolve/main/ltx-2.3-22b-dev-UD-Q4_K_M.gguf" ltx/ltx-2.3-22b-dev-UD-Q4_K_M.gguf
  fetch "$HF/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-dev_video_vae.safetensors" ltx/ltx-2.3-22b-dev_video_vae.safetensors
  fetch "$HF/unsloth/LTX-2.3-GGUF/resolve/main/vae/ltx-2.3-22b-dev_audio_vae.safetensors" ltx/ltx-2.3-22b-dev_audio_vae.safetensors
  fetch "$HF/unsloth/LTX-2.3-GGUF/resolve/main/text_encoders/ltx-2.3-22b-dev_embeddings_connectors.safetensors" ltx/ltx-2.3-22b-dev_embeddings_connectors.safetensors
  fetch "$HF/unsloth/gemma-3-12b-it-qat-GGUF/resolve/main/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf" ltx/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf
  echo "All video models present."
  exit 0
fi

fetch "$HF/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q6_K.gguf" z_image_turbo-Q6_K.gguf
fetch "$HF/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q8_0.gguf" Qwen3-4B-Instruct-2507-Q8_0.gguf
fetch "$HF/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" ae.safetensors

# 4x ESRGAN upscalers for /sdcpp/v1/upscale, picked in the UI settings; the
# server scans this directory. The Kim2091 models are CC-BY-NC-SA 4.0
# (non-commercial use only).
mkdir -p /models/upscalers
# RealESRNet is the same network trained without the GAN loss: it cleans and
# enlarges without inventing texture, so faces and text stay faithful.
fetch "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth" upscalers/RealESRNet_x4plus.pth
fetch "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" upscalers/RealESRGAN_x4plus.pth
fetch "$HF/Kim2091/UltraSharp/resolve/main/Interpolations/4x-UltraMix_Balanced.pth" upscalers/4x-UltraMix_Balanced.pth
fetch "$HF/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors" upscalers/4x-UltraSharp.safetensors

# FLUX.2 klein 9B for instruction-based editing (non-commercial license).
fetch "$HF/leejet/FLUX.2-klein-9B-GGUF/resolve/main/flux-2-klein-9b-Q8_0.gguf" flux-2-klein-9b-Q8_0.gguf
fetch "$HF/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q6_K.gguf" Qwen3-8B-Q6_K.gguf
fetch "$HF/Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors" flux2-vae.safetensors

echo "All image models present."
