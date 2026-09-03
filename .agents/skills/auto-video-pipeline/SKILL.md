---
name: auto-video-pipeline
description: >-
  Produz automaticamente um vídeo curto a partir de um roteiro colado: cria
  storyboard e imagens com Alibaba Token Plan, anima cada imagem com
  happyhorse-1.1-r2v, gera narração local com Qwen3-TTS, cria SRT/legendas e
  entrega um MP4. Use quando o usuário espera uma produção autônoma sem
  perguntas intermediárias; não é para editar footage existente.
---

# Auto Video Pipeline

Esta é a skill de execução autônoma do projeto animavideo. O texto do usuário
é a única entrada: não reabra entrevista, storyboard ou aprovação. O pipeline
tem defaults deliberados e registra cada prompt/arquivo no manifesto para poder
retomar uma execução interrompida.

## Contrato de saída

Para cada roteiro, crie um job em
production/jobs/<titulo-slug>-<hash>/ contendo o roteiro, plan.json,
manifest.json, imagens, clipes, narração e legendas. O resultado mais fácil de
encontrar é sempre:

- output/video.mp4 — link simbólico para o último vídeo pronto;
- output/video.srt — legenda correspondente;
- production/jobs/<job>/renders/video.mp4 — arquivo do job;
- index.html — composição HyperFrames do último job.

## Defaults

As configurações ficam em pipeline.config.json e podem ser sobrescritas por
variáveis de ambiente ou por um plan.json explícito:

- 60 segundos, 9:16, 480P, com aproximadamente quatro clipes de 15s;
- bl --config token-plan para todas as operações remotas;
- bl image generate --model wan2.7-image para os quadros;
- bl video ref --model happyhorse-1.1-r2v para animar cada quadro, 3–15s por
  cena;
- Qwen3-TTS 1.7B Base local, voz de referência pt-BR, GPU CUDA quando
  disponível;
- legendas estimadas a partir do áudio se nenhum ASR local estiver instalado;
- HyperFrames é tentado como renderizador final; FFmpeg é o fallback local.

## Execução

Quando o agente principal receber o roteiro, salve-o literalmente e rode:

~~~bash
./scripts/produce-video --script-file /caminho/para/script.txt
~~~

Se houver plano pronto:

~~~bash
./scripts/produce-video --script-file script.txt --plan plan.json
~~~

O script faz nesta ordem: normaliza ou deriva o plano, gera a narração local,
mede sua duração, ajusta as cenas à duração real, gera as imagens em paralelo,
envia cada imagem para o R2V em paralelo, normaliza e monta os clipes, cria SRT,
escreve o index.html, verifica/renderiza HyperFrames e atualiza os links em
output/. Arquivos válidos são reutilizados; .part não é considerado entrega.

Não use bl para escrever o roteiro ou fazer raciocínio comum. Para geração de
mídia, respeite a skill bailian-gen e o protocolo bailian-protocol; caminhos
locais de imagem podem ser passados diretamente ao CLI. Nunca passe a chave API
na linha de comando nem a salve no projeto. Se o perfil Token Plan não estiver
autenticado, pare com:

~~~bash
bl auth login --config token-plan --api-key <sua-chave-sk-sp>
~~~

O fallback de vídeo estático só é permitido quando uma chamada R2V individual
falha depois de a imagem ter sido obtida; isso fica explícito no manifesto. Uma
falha de autenticação, de imagem ou do Qwen TTS interrompe o job, pois esconder
esse problema produziria uma entrega enganosa.

## Agentes e revisão

Para julgamento narrativo, o agente pode delegar a storyboard_director. Para
auditoria final, use delivery_auditor em modo somente leitura. O pedido deste
projeto é autônomo: não abra o Studio para esperar aprovação e não pare entre
imagem, vídeo, áudio e render. A única pausa legítima é uma falha externa que
não pode ser resolvida localmente.

## Referências locais

- Leia references/storyboard-schema.md ao criar ou corrigir um plano manualmente.
- Leia references/provider-contract.md ao diagnosticar Alibaba, Qwen ou FFmpeg.
