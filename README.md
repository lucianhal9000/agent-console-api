# Multi-Agent Research Assistant
### LangGraph + Claude (Anthropic)

A production-style multi-agent system that researches any topic using
a **Supervisor → Researcher → Critic → Summarizer** pipeline with real-time
web search, iterative critique loops, and a final structured report.

---

## Architecture

```
START
  │
  ▼
Supervisor ──────────────────────────────┐
  │                                       │ (loop back after each agent)
  ├──[research]──► Researcher             │
  │                (web search, gather)   │
  │                     └────────────────►┘
  │
  ├──[critique]──► Critic                 │
  │                (evaluate quality)     │
  │                     └────────────────►┘
  │
  └──[summarize]─► Summarizer
                   (final report)
                        │
                        ▼
                       END
```

**Shared State** (immutable TypedDict, merged by LangGraph reducers):
```python
{
  "topic":      str,        # research question
  "findings":   list[str],  # accumulated (operator.add reducer)
  "critique":   str,        # latest critic feedback
  "report":     str,        # final output
  "next_agent": str,        # supervisor's routing decision
  "iterations": int,        # loop counter (guards against infinite loops)
}
```

---

## Project Structure

```
research_assistant/
├── main.py                     # Entry point + streaming console output
├── requirements.txt
├── agents/
│   ├── supervisor.py           # Routes to next agent
│   ├── researcher.py           # Web search via Claude tool use
│   ├── critic.py               # Evaluates & scores research
│   └── summarizer.py           # Produces final markdown report
├── graphs/
│   └── research_graph.py       # StateGraph definition + compilation
└── utils/
    ├── state.py                # ResearchState TypedDict
    └── llm.py                  # Centralized Anthropic client
```

---

## Setup

```bash
# 1. Create virtual environment
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set your Anthropic API key
export ANTHROPIC_API_KEY="sk-ant-..."
```

---

## Usage

```bash
# Pass topic as argument
python main.py "impact of large language models on software engineering"

# Or interactive prompt
python main.py
```

The report is printed to console and saved as `research_report.md`.

---

## Key LangGraph Concepts Demonstrated

| Concept | Where |
|---|---|
| `TypedDict` state with reducers | `utils/state.py` |
| `StateGraph` + `add_node` | `graphs/research_graph.py` |
| `add_conditional_edges` | `graphs/research_graph.py` |
| `MemorySaver` checkpointing | `graphs/research_graph.py` |
| Agentic tool-use loop | `agents/researcher.py` |
| Immutable state updates (return dicts) | All agent nodes |
| Loop guard via iteration counter | `agents/supervisor.py` |

---

## Extending the Project

- **Add a new agent**: define a function `my_agent(state) -> dict`, register with
  `builder.add_node("my_agent", my_agent)`, add edges, update the supervisor prompt.
- **Persistent storage**: swap `MemorySaver` for `SqliteSaver` or `PostgresSaver`.
- **API endpoint**: wrap `run_research()` in a FastAPI route for a REST interface.
- **Streaming to frontend**: use `graph.astream()` with `async for` in an async FastAPI handler.
