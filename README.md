# animavideo

Fábrica automática de vídeos verticais a partir de um roteiro. O projeto cria
o storyboard, gera imagens e clipes com Alibaba Token Plan, produz a narração
localmente, cria legendas e entrega um MP4 pronto para publicar.

> A geração de imagens e vídeos usa créditos do Alibaba Token Plan. As chaves,
> os modelos locais e os renders ficam fora do Git.

## Como funciona

```text
roteiro.txt
    ↓
plano de cenas → Qwen3-TTS local → imagens wan2.7-image
                                      ↓
                         vídeos happyhorse-1.1-r2v
                                      ↓
                   FFmpeg + SRT + HyperFrames/fallback
                                      ↓
                         output/video.mp4
```

Por padrão, o pipeline produz aproximadamente 60 segundos em 9:16 e 480P,
divididos em clipes de cerca de 15 segundos. Os valores ficam em
[`pipeline.config.json`](pipeline.config.json).

## Requisitos

O fluxo principal foi escrito para Linux e usa scripts Bash:

- Node.js 22;
- Python 3 e um ambiente com Qwen3-TTS instalado;
- FFmpeg e FFprobe;
- CLI `bl` da Alibaba/Bailian com o perfil `token-plan` autenticado;
- GPU NVIDIA/CUDA é recomendada para o Qwen3-TTS, mas não é necessária para
  todas as operações locais;
- para a WebUI: `curl`, `jq` e, opcionalmente, Piper, Kokoro e
  faster-whisper para as vozes e legendas locais.

Os pesos dos modelos não são distribuídos neste repositório.

## Configuração inicial

Clone o projeto e entre na pasta:

```bash
git clone https://github.com/Caio-Angelis/animavideo.git
cd animavideo
```

Autentique o CLI sem colocar a chave em arquivos versionados:

```bash
bl auth login --config token-plan --api-key <sua-chave-sk-sp>
bl auth status --config token-plan --output json
```

O pipeline procura automaticamente o Python do Qwen em alguns caminhos locais.
Em outra máquina, informe explicitamente o ambiente:

```bash
export QWEN_TTS_PYTHON=/caminho/para/qwen3-tts-env/bin/python
```

O arquivo [`pipeline.config.json`](pipeline.config.json) aponta para
`assets/voice/ptbr-reference.wav`. Substitua essa referência por um WAV seu,
com autorização para clonagem de voz, ou aponte para outro arquivo:

```bash
export QWEN_TTS_REFERENCE=/caminho/absoluto/referencia.wav
```

## Produção pelo terminal

Passe qualquer texto narrativo como roteiro:

```bash
./scripts/produce-video --script-file /caminho/para/roteiro.txt
```

Opções úteis:

```bash
# Refazer a mídia do job
./scripts/produce-video --script-file roteiro.txt --force

# Usar um plano de cenas escrito manualmente
./scripts/produce-video --script-file roteiro.txt --plan plan.json

# Validar plano e configuração sem chamar os provedores
./scripts/produce-video --script-file roteiro.txt --dry-run

# Pular a tentativa de renderização HyperFrames
./scripts/produce-video --script-file roteiro.txt --skip-hyperframes
```

O resultado mais fácil de encontrar é:

- `output/video.mp4` — vídeo final;
- `output/video.srt` — legenda correspondente;
- `production/jobs/<titulo>-<hash>/` — manifesto, plano, áudio e arquivos do
  job. Essa pasta é gerada e ignorada pelo Git.

O pipeline reutiliza arquivos válidos. Se o renderizador HyperFrames falhar
depois que a mídia foi criada, ele tenta concluir com FFmpeg e registra o
fallback no manifesto.

## WebUI local

A WebUI permite gerar vídeos pelo navegador. Por segurança, deixe a chave fora
do repositório em um arquivo de uma linha e informe o caminho por variável:

```bash
TOKEN_PLAN_KEY_FILE=/caminho/seguro/token-plan.key npm run webui
```

Abra <http://127.0.0.1:8787>. A interface oferece geração por texto, imagem de
referência, ciclo completo de três takes e uma matriz de 27 combinações. Os
resultados são salvos em `outputs/`, que é ignorado pelo Git.

O servidor escuta apenas em `127.0.0.1` por padrão. Para usar outra máquina na
mesma rede, configure `WEBUI_HOST` conscientemente e proteja a rede; não
exponha uma instância com acesso à chave diretamente na internet.

Se a GPU NVIDIA não estiver disponível para reencodar os vídeos, force o
encoder de CPU:

```bash
WEBUI_VIDEO_ENCODER=libx264 \
TOKEN_PLAN_KEY_FILE=/caminho/seguro/token-plan.key npm run webui
```

## Configuração principal

| Campo | Função | Padrão |
| --- | --- | --- |
| `target_duration_s` | duração-alvo total | `60` |
| `ratio` | proporção do vídeo | `9:16` |
| `resolution` | resolução remota | `480P` |
| `bl_config` | perfil do `bl` | `token-plan` |
| `image_model` | modelo dos quadros | `wan2.7-image` |
| `video_model` | modelo de animação | `happyhorse-1.1-r2v` |
| `qwen_reference` | referência de voz | `assets/voice/ptbr-reference.wav` |
| `try_hyperframes` | tenta render final HyperFrames | `true` |

Também é possível sobrescrever os caminhos do TTS, Piper, Kokoro e Whisper por
variáveis de ambiente. Veja os nomes aceitos em `webui/server.mjs` e em
`.agents/skills/auto-video-pipeline/scripts/produce_video.py`.

## Estrutura do projeto

```text
.agents/skills/auto-video-pipeline/  pipeline automático e referências
scripts/                             atalhos de produção e HyperFrames
webui/                               servidor e interface local
assets/voice/                        referência de voz
pipeline.config.json                 defaults de produção
hyperframes.json                     configuração HyperFrames
production/inbox/                    entrada temporária de roteiro/plano
output/, outputs/                     resultados locais (ignorados)
```

`index.html` também é recriado pelo pipeline para o job mais recente; por isso
não é uma fonte estática versionada.

## Verificações rápidas

```bash
node --check webui/server.mjs
python3 -m py_compile \
  .agents/skills/auto-video-pipeline/scripts/produce_video.py \
  .agents/skills/auto-video-pipeline/scripts/qwen_tts_local.py \
  webui/kokoro_batch.py webui/local_caption_pipeline.py
```

Depois de gerar um job, o contrato HyperFrames pode ser verificado com:

```bash
npm run check
```

## Segurança e compartilhamento

Nunca faça commit de API keys, `password.txt`, arquivos `.env`, logs com
segredos ou renders desnecessários. O `.gitignore` já cobre esses casos e os
diretórios de saída. A chave usada pela WebUI deve ficar em um arquivo externo,
com permissões restritas, e a referência de voz só deve ser compartilhada com
o consentimento da pessoa gravada.

Este é um projeto experimental: a disponibilidade dos modelos, os limites do
Token Plan e os requisitos dos modelos locais podem mudar. Se algo falhar,
consulte primeiro a mensagem do pipeline e confirme autenticação, caminhos dos
ambientes Python e instalação do FFmpeg.
