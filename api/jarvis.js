const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const MAX_BODY_BYTES = 180000;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function buildSystemPrompt(notes) {
  const notesText =
    notes.length > 0
      ? notes
          .map(
            (note) =>
              `- [${String(note.area).toUpperCase()}] ${note.title}: ${note.body}`,
          )
          .join("\n")
      : "Nenhuma nota foi registrada ainda.";

  return `Você é Jarvis, um assistente pessoal com personalidade de formal britânico (mordomo). Você atende Sandro.

Responda diretamente ao que Sandro perguntar, inclusive perguntas gerais que não estejam no Second Brain. Seja útil, claro e honesto: não invente fatos e diga quando não tiver informação suficiente. Responda em português do Brasil, sem emojis e sem markdown, pois a resposta também será falada em voz alta. Para perguntas simples, seja conciso; para perguntas complexas, explique o necessário com organização e exemplos.

Regra de Memória Viva: se Sandro revelar algo novo e duradouro sobre si, seus objetivos, trabalho, projetos, saúde, finanças, aprendizado ou relações, termine a resposta com uma linha no formato EXATO [[SAVE:area|titulo|texto]], usando uma destas áreas: meta, metas, trabalho, projetos, financas, aprendizado, saude, relacoes. Só use essa linha quando realmente houver uma informação nova e persistente.

SECOND BRAIN (notas atuais de Sandro):
${notesText}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(new Error("request_too_large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });

    req.on("error", reject);
  });
}

function validateBody(body) {
  if (!body || typeof body.prompt !== "string" || !body.prompt.trim()) {
    return "Pergunta inválida.";
  }

  if (body.prompt.length > 16000) {
    return "A pergunta é muito longa.";
  }

  if (body.history !== undefined && !Array.isArray(body.history)) {
    return "Histórico inválido.";
  }

  if (body.notes !== undefined && !Array.isArray(body.notes)) {
    return "Notas inválidas.";
  }

  if ((body.history || []).length > 40) {
    return "Histórico muito longo.";
  }

  if ((body.notes || []).length > 200) {
    return "Quantidade de notas muito grande.";
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return json(res, 405, {
      error: "Método não permitido.",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return json(res, 401, {
      error: "GEMINI_API_KEY não está configurada na Vercel.",
    });
  }

  let body;

  try {
    body = await parseBody(req);
  } catch (error) {
    return json(
      res,
      error.message === "request_too_large" ? 413 : 400,
      {
        error:
          error.message === "request_too_large"
            ? "Requisição muito grande."
            : "JSON inválido.",
      },
    );
  }

  const validationError = validateBody(body);

  if (validationError) {
    return json(res, 400, {
      error: validationError,
    });
  }

  const history = (body.history || []).filter(
    (message) =>
      message &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string",
  );

  const notes = (body.notes || []).filter(
    (note) =>
      note &&
      typeof note.area === "string" &&
      typeof note.title === "string" &&
      typeof note.body === "string",
  );

  const contents = [
    ...history.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [
        {
          text: message.content,
        },
      ],
    })),

    {
      role: "user",
      parts: [
        {
          text: body.prompt,
        },
      ],
    },
  ];

  const endpoint = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
  );

  endpoint.searchParams.set("key", apiKey);

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [
            {
              text: buildSystemPrompt(notes),
            },
          ],
        },

        contents,

        generationConfig: {
          maxOutputTokens: 1200,
          temperature: 0.7,
        },
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return json(res, upstream.status === 429 ? 429 : 502, {
        error:
          upstream.status === 429
            ? "O limite gratuito do Google AI Studio foi atingido. Aguarde a renovação do limite ou use uma chave com cota disponível."
            : data.error?.message ||
              "O serviço Gemini não conseguiu responder agora.",
      });
    }

    const text = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part.text || "")
      .join("")
      .trim();

    if (!text) {
      return json(res, 502, {
        error: "O Gemini devolveu uma resposta vazia.",
      });
    }

    return json(res, 200, {
      text,
    });
  } catch {
    return json(res, 502, {
      error: "Não foi possível conectar ao núcleo de inteligência do Jarvis.",
    });
  }
}
