#!/bin/bash
echo "Downloading Nemotron models..."
ollama pull nemotron:latest 2>/dev/null || echo "Nemotron not yet on Ollama, using fallback"
ollama pull llama3.2:latest
ollama pull qwen2.5-coder:latest
echo "Models ready."
