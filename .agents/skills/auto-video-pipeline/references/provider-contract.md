# Contrato de provedores e diagnóstico

O CLI remoto é o bl 1.18.x instalado no prefixo do usuário. A sessão deve
estar autenticada no perfil token-plan antes da primeira geração:

~~~bash
bl auth status --config token-plan --output json
~~~

Chamadas usadas pelo pipeline:

~~~bash
bl image generate --config token-plan --model wan2.7-image \\
  --prompt "..." --size 3:4 --watermark false --out-dir <dir> \\
  --out-prefix scene-01

bl video ref --config token-plan --model happyhorse-1.1-r2v \\
  --prompt "Image 1 is the visual reference. ..." --image <local.png> \\
  --resolution 480P --ratio 9:16 --duration 15 --watermark false \\
  --download <scene.mp4> --poll-interval 15
~~~

O CLI faz o upload temporário dos caminhos locais; não há servidor de upload no
projeto. As imagens/clipes podem consumir créditos do Token Plan.

O TTS usa a API Python oficial Qwen3TTSModel com o modelo local
Qwen3-TTS-12Hz-1.7B-Base, dtype=torch.bfloat16, device_map=cuda:0 e
generate_voice_clone com referência local. O modelo não fornece timestamps de
palavra neste caminho; o script cria SRT proporcional à duração do áudio.

FFmpeg só é usado para sondagem, normalização de clipes, slideshow de fallback,
normalização de áudio e fallback final. As credenciais do Alibaba não devem
aparecer em logs ou manifestos.
