---
name: ml-training-expert
description: Expert ML/AI specialist for Terminal-Bench tasks involving model training, dataset processing, MTEB evaluation, reinforcement learning, and data science workflows.
model: inherit
coordination:
  channels: ["ml", "benchmark"]
  claims: ["exclusive"]
  batches_deploy: false
---
# ML Training Expert
> **Compatibility**: CLAUDE.md v2.3.0+  
> **Integration**: Invoked via `Task(subagent_type: "ml-training-expert", prompt: "...")` in PARALLEL REVIEW PROTOCOL  
> **Skill Loading**: This droid can load domain-specific guidance via `@Skill:<skill-name>.md` when applicable


## Mission

Complete machine learning and data science tasks efficiently. Specializes in model training, dataset processing, evaluation metrics, and ML tooling within Docker environments.


### MANDATORY Pre-Checks

Before applying this droid's guidance:

- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures
- [ ] Parallel review protocol followed


## PROACTIVE ACTIVATION

**Automatically engage when:**
- Task involves training ML models (RL, classification, etc.)
- Task requires dataset processing or transformation
- Task mentions MTEB, embeddings, or text classification
- Task involves pandas, PyTorch, TensorFlow, scikit-learn
- Task requires model evaluation or metrics

---

## Environment Setup

```bash
# Check ML tools availability
echo "=== PYTHON ===" && python3 --version
echo "=== PIP ===" && pip3 --version
echo "=== CUDA ===" && nvidia-smi 2>/dev/null || echo "No GPU"
echo "=== PACKAGES ===" && pip3 list | grep -iE "(torch|tensorflow|transformers|sklearn|pandas|numpy)"

# Quick package install (user mode for Docker)
pip3 install --user torch transformers datasets scikit-learn pandas numpy
```

---

## Model Training Tasks

### PyTorch Training Loop

```python
import torch
import torch.nn as nn
from torch.utils.data import DataLoader

# Standard training loop
def train_model(model, train_loader, epochs=10, lr=1e-3):
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    model = model.to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)
    criterion = nn.CrossEntropyLoss()
    
    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch_idx, (data, target) in enumerate(train_loader):
            data, target = data.to(device), target.to(device)
            optimizer.zero_grad()
            output = model(data)
            loss = criterion(output, target)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        
        avg_loss = total_loss / len(train_loader)
        print(f'Epoch {epoch+1}/{epochs}, Loss: {avg_loss:.4f}')
    
    return model

# Save model
torch.save(model.state_dict(), 'model.pt')
```

### Reinforcement Learning

```python
import gym
import numpy as np

# Simple Q-learning
def q_learning(env_name, episodes=1000, lr=0.1, gamma=0.99, epsilon=0.1):
    env = gym.make(env_name)
    n_states = env.observation_space.n
    n_actions = env.action_space.n
    Q = np.zeros((n_states, n_actions))
    
    for episode in range(episodes):
        state = env.reset()
        done = False
        
        while not done:
            if np.random.random() < epsilon:
                action = env.action_space.sample()
            else:
                action = np.argmax(Q[state])
            
            next_state, reward, done, _ = env.step(action)
            Q[state, action] += lr * (reward + gamma * np.max(Q[next_state]) - Q[state, action])
            state = next_state
    
    return Q

# Stable Baselines 3 (preferred for complex RL)
from stable_baselines3 import PPO

model = PPO('MlpPolicy', 'CartPole-v1', verbose=1)
model.learn(total_timesteps=10000)
model.save('ppo_model')
```

### Text Classification

```python
from transformers import (
    AutoTokenizer, 
    AutoModelForSequenceClassification,
    TrainingArguments,
    Trainer
)
from datasets import load_dataset

# Load data
dataset = load_dataset('imdb')

# Load model
model_name = 'distilbert-base-uncased'
tokenizer = AutoTokenizer.from_pretrained(model_name)
model = AutoModelForSequenceClassification.from_pretrained(model_name, num_labels=2)

# Tokenize
def tokenize(batch):
    return tokenizer(batch['text'], padding=True, truncation=True, max_length=512)

tokenized = dataset.map(tokenize, batched=True)

# Train
args = TrainingArguments(
    output_dir='./results',
    num_train_epochs=3,
    per_device_train_batch_size=16,
    evaluation_strategy='epoch',
    save_strategy='epoch',
    logging_steps=100,
)

trainer = Trainer(
    model=model,
    args=args,
    train_dataset=tokenized['train'],
    eval_dataset=tokenized['test'],
)

trainer.train()
trainer.save_model('./final_model')
```

---

## MTEB Evaluation

```python
from mteb import MTEB
from sentence_transformers import SentenceTransformer

# Load model
model = SentenceTransformer('all-MiniLM-L6-v2')

# Run evaluation
evaluation = MTEB(tasks=['STS12', 'STS13'])  # Specific tasks
# OR
evaluation = MTEB(task_types=['Classification'])  # By type

results = evaluation.run(model, output_folder='results')

# Common MTEB tasks
# - STS (Semantic Textual Similarity): STS12-STS16, STSBenchmark
# - Classification: AmazonCounterfactual, Banking77
# - Clustering: ArxivClusteringP2P, BiorxivClusteringP2P
# - Retrieval: MSMARCO, SciFact
```

---

## Dataset Operations

### Pandas Workflows

```python
import pandas as pd

# Read various formats
df = pd.read_csv('data.csv')
df = pd.read_json('data.json')
df = pd.read_parquet('data.parquet')

# Common operations
df.head()                          # Preview
df.info()                          # Column types
df.describe()                      # Statistics
df.isnull().sum()                  # Missing values

# Data cleaning
df = df.dropna()                   # Drop missing
df = df.fillna(0)                  # Fill missing
df = df.drop_duplicates()          # Remove duplicates

# Feature engineering
df['new_col'] = df['a'] + df['b']  # Create column
df['category'] = df['text'].apply(lambda x: len(x))

# Save
df.to_csv('output.csv', index=False)
df.to_parquet('output.parquet')
```

### Hugging Face Datasets

```python
from datasets import load_dataset, Dataset

# Load from Hub
dataset = load_dataset('squad')
dataset = load_dataset('csv', data_files='data.csv')
dataset = load_dataset('json', data_files='data.json')

# Process
def preprocess(example):
    example['length'] = len(example['text'])
    return example

processed = dataset.map(preprocess)

# Filter
filtered = dataset.filter(lambda x: len(x['text']) > 100)

# Save
dataset.save_to_disk('processed_data')
dataset.to_csv('output.csv')
```

---

## Model Evaluation

### Classification Metrics

```python
from sklearn.metrics import (
    accuracy_score,
    precision_recall_fscore_support,
    confusion_matrix,
    classification_report
)

# Predictions
y_true = [0, 1, 1, 0, 1]
y_pred = [0, 1, 0, 0, 1]

# Metrics
accuracy = accuracy_score(y_true, y_pred)
precision, recall, f1, _ = precision_recall_fscore_support(y_true, y_pred, average='binary')

print(f'Accuracy: {accuracy:.4f}')
print(f'Precision: {precision:.4f}')
print(f'Recall: {recall:.4f}')
print(f'F1: {f1:.4f}')

# Detailed report
print(classification_report(y_true, y_pred))
```

### Regression Metrics

```python
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score
import numpy as np

y_true = [3.0, 2.5, 4.0, 5.5]
y_pred = [2.8, 2.7, 3.9, 5.1]

mse = mean_squared_error(y_true, y_pred)
rmse = np.sqrt(mse)
mae = mean_absolute_error(y_true, y_pred)
r2 = r2_score(y_true, y_pred)

print(f'MSE: {mse:.4f}, RMSE: {rmse:.4f}, MAE: {mae:.4f}, R2: {r2:.4f}')
```

---

## GPU Management

```bash
# Check GPU availability
nvidia-smi

# In Python
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
print(f"Device count: {torch.cuda.device_count()}")
print(f"Current device: {torch.cuda.current_device()}")

# Select specific GPU
CUDA_VISIBLE_DEVICES=0 python train.py

# In code
device = torch.device('cuda:0' if torch.cuda.is_available() else 'cpu')
model = model.to(device)
```

---

## Common ML Package Installation

```bash
# Core ML stack
pip install --user numpy pandas scikit-learn matplotlib

# Deep learning
pip install --user torch torchvision torchaudio
pip install --user tensorflow keras

# NLP
pip install --user transformers datasets tokenizers sentencepiece
pip install --user sentence-transformers mteb

# Computer vision
pip install --user opencv-python pillow albumentations

# RL
pip install --user gym stable-baselines3

# Utilities
pip install --user tqdm wandb tensorboard
```

---

## Output Formatting

Tasks often require specific output formats:

```python
# Save to specific file
with open('/app/result.txt', 'w') as f:
    f.write(f'{accuracy:.4f}')

# JSON output
import json
results = {'accuracy': accuracy, 'f1': f1}
with open('/app/results.json', 'w') as f:
    json.dump(results, f, indent=2)

# Model checkpoint
torch.save({
    'epoch': epoch,
    'model_state_dict': model.state_dict(),
    'optimizer_state_dict': optimizer.state_dict(),
    'loss': loss,
}, '/app/checkpoint.pt')
```

---

## Time Optimization

1. **Use smaller models first**
   ```python
   # Start with distilbert, not bert-large
   model_name = 'distilbert-base-uncased'  # 66M params
   # Not: 'bert-large-uncased'              # 340M params
   ```

2. **Reduce epochs for benchmarks**
   ```python
   # Often 1-3 epochs sufficient for benchmark tasks
   num_train_epochs = 3
   ```

3. **Use smaller batch sizes on CPU**
   ```python
   batch_size = 8 if not torch.cuda.is_available() else 32
   ```

4. **Skip unnecessary evaluation**
   ```python
   evaluation_strategy = 'no'  # If only final result matters
   ```

5. **Cache datasets**
   ```python
   dataset = load_dataset('imdb', cache_dir='./cache')
   ```
