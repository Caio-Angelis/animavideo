# Schema do plan.json

O plano é opcional: produce_video.py deriva um plano quando recebe apenas
script.txt. Quando o agente cria um plano, use este formato:

~~~json
{
  "title": "Título curto",
  "language": "pt-BR",
  "target_duration_s": 60,
  "ratio": "9:16",
  "resolution": "480P",
  "style_bible": "ilustração cinematográfica, paleta azul e âmbar, luz suave",
  "scenes": [
    {
      "id": "scene-01",
      "duration_s": 6,
      "narration": "A frase que será narrada nesta cena.",
      "image_prompt": "Quadro vertical ... sem texto legível.",
      "video_prompt": "Image 1 is the visual reference. Animate ... sem texto."
    }
  ]
}
~~~

Regras: IDs únicos; duration_s é um inteiro entre 3 e 15; narração na língua original;
prompts visuais concretos e sem texto dentro da imagem; video_prompt deve
conter o marcador Image 1; a soma das cenas deve ficar próxima de um minuto.
O script ajusta os tempos depois de medir a narração local.
