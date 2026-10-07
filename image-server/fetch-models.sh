#!/bin/sh
# Downloads the Z-Image-Turbo weights (~10 GB) and the ESRGAN upscaler used by
# the image server.
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

fetch "$HF/leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q6_K.gguf" z_image_turbo-Q6_K.gguf
fetch "$HF/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q8_0.gguf" Qwen3-4B-Instruct-2507-Q8_0.gguf
fetch "$HF/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors" ae.safetensors

# 4x ESRGAN upscalers for /sdcpp/v1/upscale, picked in the UI settings; the
# server scans this directory. The Kim2091 models are CC-BY-NC-SA 4.0
# (non-commercial use only).
mkdir -p /models/upscalers
fetch "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" upscalers/RealESRGAN_x4plus.pth
fetch "$HF/Kim2091/UltraSharp/resolve/main/Interpolations/4x-UltraMix_Balanced.pth" upscalers/4x-UltraMix_Balanced.pth
fetch "$HF/Kim2091/UltraSharp/resolve/main/4x-UltraSharp.safetensors" upscalers/4x-UltraSharp.safetensors

echo "All image models present."
