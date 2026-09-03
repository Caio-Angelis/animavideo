# animavideo — fábrica automática de vídeos

Este repositório é uma fábrica de vídeos. Quando o usuário colar um roteiro,
enredo, história ou texto narrativo com intenção de virar um vídeo (mesmo que
ele não repita “faça um vídeo”), trate a mensagem como uma solicitação de
produção completa.

## Regra principal: roteiro é a única entrada

1. Leia .agents/skills/auto-video-pipeline/SKILL.md antes de agir.
2. Não peça formato, estilo, voz, número de cenas, aprovação do storyboard ou
   confirmação intermediária. Use pipeline.config.json e os defaults da skill.
3. Salve o texto recebido literalmente em production/inbox/roteiro.txt e
   execute:

   ~~~bash
   ./scripts/produce-video --script-file production/inbox/roteiro.txt
   ~~~

4. Espere o processo terminar, verifique que output/video.mp4 existe e
   informe o caminho final, duração e eventuais fallbacks. Não entregue apenas
   código ou um plano.

O usuário já escolheu explicitamente Alibaba Token Plan e autorizou o fluxo de
mídia. A produção usa bl --config token-plan, imagens via bl image generate
e animação via bl video ref --model happyhorse-1.1-r2v. Nunca passe API keys
como argumento, nunca grave credenciais no repositório e nunca imprima segredos.
Se a autenticação estiver ausente, pare com a instrução exata de login; não
troque silenciosamente para outro provedor.

A narração padrão é local, usando o Qwen3-TTS já instalado em
/home/caio/Área de trabalho/ProjetosPessoais/TTS/qwen3-tts-env, com a
referência pt-BR em assets/voice/ptbr-reference.wav. O pipeline gera também
SRT e legendas renderizadas no vídeo.

## Agentes

Quando a tarefa exigir julgamento narrativo, delegue a criação/checagem do
plan.json ao storyboard_director; quando a mídia terminar, peça ao
delivery_auditor uma verificação somente leitura. O operador pode executar o
pipeline, mas não deve redesenhar o plano nem pedir confirmação ao usuário.
Não faça dois agentes escreverem o mesmo arquivo ao mesmo tempo.

## HyperFrames

O index.html é atualizado pelo pipeline para servir de composição/preview e
seguir o contrato HyperFrames: root dimensionado, data-start="0", duração
fixa, clips não sobrepostos por track, vídeos muted/playsinline, áudio em
elemento separado e timeline GSAP pausada registrada em
window.__timelines. Use ./scripts/hyperframes para que Node 22 seja
selecionado automaticamente. Se a checagem/renderização HyperFrames falhar
depois que a mídia foi gerada, use o fallback FFmpeg do próprio pipeline,
registre isso no manifesto e ainda entregue o MP4.

## Escopo

Para uma edição deliberada de código ou de uma composição existente, siga o
pedido específico do usuário. As regras automáticas acima se aplicam ao fluxo
de criação de vídeo a partir de roteiro.
