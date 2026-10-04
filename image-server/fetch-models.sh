#!/bin/sh
# Downloads the Z-Image-Turbo weights (~10 GB) used by the image server.
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

echo "All image models present."
