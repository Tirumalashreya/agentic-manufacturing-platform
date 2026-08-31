from typing import TypedDict
from langgraph.graph import StateGraph, START, END

from app import db


class PipelineState(TypedDict):
    run_id: str
    raw_lead_input: str
    # more fields get added here as each new agent's output joins the state


def build_graph():
    graph = StateGraph(PipelineState)
    # nodes get added here, one per agent, as you build them
    graph.add_edge(START, END)  # placeholder until the first real node exists
    return graph.compile()


pipeline_graph = build_graph()
