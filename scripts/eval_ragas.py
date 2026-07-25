import os
import json

def run_evaluation():
    try:
        from datasets import Dataset
        from ragas import evaluate
        from ragas.metrics import (
            faithfulness,
            answer_relevance,
            context_precision,
            context_recall,
        )
    except ImportError:
        print("⚠️ Module ragas atau datasets belum terinstall. Install dengan: pip install ragas datasets pandas")
        return

    dataset_path = os.path.join(os.path.dirname(__file__), "..", "eval_dataset.json")
    if not os.path.exists(dataset_path):
        print(f"❌ File dataset {dataset_path} tidak ditemukan!")
        return

    with open(dataset_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    dataset_dict = {
        "question": [item["user_input"] for item in data],
        "answer": [item["response"] for item in data],
        "contexts": [item["retrieved_contexts"] for item in data],
        "ground_truth": [item["ground_truth"] for item in data]
    }

    eval_dataset = Dataset.from_dict(dataset_dict)

    print("\n🚀 Memulai Evaluasi RAGAS (Silo RAG Pipeline)...")
    results = evaluate(
        dataset=eval_dataset,
        metrics=[
            faithfulness,
            answer_relevance,
            context_precision,
            context_recall,
        ],
    )

    print("\n=== HASIL EVALUASI RAGAS (SILO RAG PIPELINE) ===")
    print(results)

    df = results.to_pandas()
    report_path = os.path.join(os.path.dirname(__file__), "..", "ragas_evaluation_report.csv")
    df.to_csv(report_path, index=False)
    print(f"✅ Laporan evaluasi berhasil disimpan ke {report_path}")

if __name__ == "__main__":
    run_evaluation()
