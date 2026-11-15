# Three Musketeers

A group chat with three agents:
- Stephen Curry knows about sports
- Remy the Rat knows about foods and restaurants
- Lightning McQueen knows about cars

## Setup

Node 22 or newer.

```
npm install
cp .env.example .env
```

Put your API key in `.env`. `MODEL_BASE_URL`, `MODEL_NAME`, and `MODEL_API_KEY` are any OpenAI-compatible chat API. The example uses OpenAI. For DeepSeek:

```
MODEL_BASE_URL=https://api.deepseek.com
MODEL_NAME=deepseek-flash
MODEL_API_KEY=your-key
```

Live scores, prices, and open restaurants are searched only when the URL is DeepSeek.

## Run

```
npm start
```

Open http://localhost:3000.
