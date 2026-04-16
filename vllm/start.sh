#!/bin/bash
python -m vllm.entrypoints.openai.api_server \
    --model slseanwu/MIDI-LLM_Llama-3.2-1B \
    --host 0.0.0.0 \
    --port 8000 \
    --max-model-len 4096 \
    --dtype auto \
    --gpu-memory-utilization 0.3 \
    --trust-remote-code
