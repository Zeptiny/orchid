import asyncio
import logging
from pathlib import Path
from xml.sax.saxutils import escape

from stupidex.config import get_config
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties
from stupidex.rag.embedder import Embedder, EmbeddingError
from stupidex.rag.indexer import IndexResult, clear_index, get_status, index_project
from stupidex.rag.store import RAGStore

logger = logging.getLogger(__name__)

# Register the RAG indexer's update_file so edit/write tools keep the RAG store in sync.
from stupidex.rag.indexer import update_file as _rag_update_file  # noqa: E402
from stupidex.tools.ast import post_write_callbacks  # noqa: E402

post_write_callbacks.append(_rag_update_file)

rag_search_tool = Tool(
    name="rag_search",
    description="Search codebase semantically. Returns code snippets ranked by semantic relevance. Use when grep/glob are insufficient for finding concepts by meaning rather than exact text.",
    parameters=ToolParameter(
        properties={
            "query": ToolParameterProperties(
                type="string",
                description="The semantic search query describing what you're looking for",
            ),
            "top_k": ToolParameterProperties(
                type="integer",
                description="Maximum number of results to return (default: 5)",
            ),
            "file_pattern": ToolParameterProperties(
                type="string",
                description="Glob pattern to filter results (e.g., '*.py', 'src/**/*.ts'). Optional.",
            ),
        },
        required=["query"],
    ),
    action_label="Ragging...",
)

rag_index_tool = Tool(
    name="rag_index",
    description="Check RAG index status, trigger re-indexing, or clear the index.",
    parameters=ToolParameter(
        properties={
            "action": ToolParameterProperties(
                type="string",
                description="The action to perform: 'status' to check index state, 'index' to (re)index the project, 'clear' to delete the index.",
            ),
        },
        required=["action"],
    ),
    action_label="Managing Ragging...",
)


async def execute_rag_search(
    query: str,
    top_k: int | None = None,
    file_pattern: str | None = None,
) -> ExecutorResult:
    if not query or not query.strip():
        return ExecutorResult(
            display="Empty query",
            content='<rag_error query="">query is required and cannot be empty.</rag_error>',
        )

    cfg = get_config()
    project_path = str(Path.cwd())
    store = RAGStore(project_path)

    if top_k is None:
        top_k = cfg.rag.top_k
    if top_k <= 0:
        return ExecutorResult(
            display="Invalid top_k",
            content=f'<rag_error top_k="{top_k}">top_k must be a positive integer.</rag_error>',
        )

    pre_check = store.status()
    if pre_check.last_indexed is None and pre_check.total_chunks == 0:
        return ExecutorResult(
            display="No RAG index",
            content='<rag_error>No RAG index found. Use rag_index with action="index".</rag_error>',
        )

    try:
        embedder = Embedder(model=cfg.rag.embedding_model or None)
        query_embedding = await embedder.embed_single(query)
    except EmbeddingError as e:
        return ExecutorResult(
            display="Embedding failed",
            content=f'<rag_error query="{escape(query)}">Embedding failed: {escape(str(e))}</rag_error>',
        )
    except Exception as e:
        logger.warning("Unexpected embedding error: %s", e)
        return ExecutorResult(
            display="Embedding error",
            content=f'<rag_error query="{escape(query)}">{escape(str(e))}</rag_error>',
        )

    loop = asyncio.get_running_loop()
    try:
        results = await loop.run_in_executor(None, store.search, query_embedding, top_k, file_pattern)
    except ValueError as e:
        return ExecutorResult(
            display="Search error",
            content=f'<rag_error query="{escape(query)}">{escape(str(e))}</rag_error>',
        )

    if not results:
        return ExecutorResult(
            display="No results",
            content=f'<rag_results query="{escape(query)}" count="0" />',
        )

    e = escape
    parts = []
    for r in results:
        parts.append(
            f'<result file="{e(r.file_path)}" lines="{r.start_line}-{r.end_line}" '
            f'score="{r.score:.3f}">\n'
            f"{e(r.content)}\n"
            f"</result>"
        )

    content = f'<rag_results query="{e(query)}" count="{len(results)}">\n' + "\n".join(parts) + "\n</rag_results>"

    return ExecutorResult(
        display=f"Found {len(results)} semantic matches",
        content=content,
    )


async def execute_rag_index(
    action: str,
) -> ExecutorResult:
    if action not in ("status", "index", "clear"):
        return ExecutorResult(
            display="Invalid action",
            content=(
                f'<rag_error action="{escape(action)}">'
                f"Unknown action. Must be one of: status, index, clear."
                f"</rag_error>"
            ),
        )

    project_path = str(Path.cwd())

    if action == "status":
        status = get_status(project_path)
        if status.last_indexed is None and status.total_chunks == 0:
            return ExecutorResult(
                display="No RAG index",
                content='<rag_status files="0" chunks="0" indexed="never" />',
            )
        return ExecutorResult(
            display="RAG index status",
            content=(
                f"<rag_status "
                f'files="{status.total_files}" '
                f'chunks="{status.total_chunks}" '
                f'indexed="{escape(status.last_indexed or "never")}" />'
            ),
        )

    if action == "clear":
        clear_index(project_path)
        return ExecutorResult(
            display="RAG index cleared",
            content='<rag_clear success="true" />',
        )

    # action == "index"
    cfg = get_config()
    embedder = Embedder(model=cfg.rag.embedding_model or None)

    progress_info: list[str] = []

    def _progress(filepath: str, done: int, total: int) -> None:
        if done % 5 == 0 or done == total - 1:
            progress_info.append(f"[{done + 1}/{total}] {filepath}")

    try:
        result: IndexResult = await index_project(
            project_path=project_path,
            force=False,
            embedder=embedder,
            progress_callback=_progress,
        )
    except EmbeddingError as e:
        return ExecutorResult(
            display="Indexing failed",
            content=(f'<rag_error action="index">Embedding failed during indexing: {escape(str(e))}</rag_error>'),
        )
    except Exception as e:
        logger.warning("Indexing failed: %s", e)
        return ExecutorResult(
            display="Indexing failed",
            content=f'<rag_error action="index">{escape(str(e))}</rag_error>',
        )

    e = escape
    errors_xml = ""
    if result.errors:
        error_items = "\n".join(f"    <error>{e(err)}</error>" for err in result.errors[:10])
        errors_xml = f'\n  <errors count="{len(result.errors)}">\n{error_items}\n  </errors>'

    content = (
        f"<rag_index "
        f'scanned="{result.files_scanned}" '
        f'indexed="{result.files_indexed}" '
        f'skipped="{result.files_skipped}" '
        f'deleted="{result.files_deleted}" '
        f'chunks="{result.chunks_created}" '
        f'duration="{result.duration_seconds:.1f}s"'
        f">"
        f"{errors_xml}\n"
        f"</rag_index>"
    )

    return ExecutorResult(
        display=f"Indexed {result.files_indexed} files ({result.chunks_created} chunks)",
        content=content,
    )
