# Mean FLIP error between artifacts/forest-pair/plain.png and cards.png (0 means identical).
import flip_evaluator
import numpy as np
from PIL import Image

reference = np.asarray(Image.open("artifacts/forest-pair/plain.png").convert("RGB"), dtype=np.float32) / 255
test = np.asarray(Image.open("artifacts/forest-pair/cards.png").convert("RGB"), dtype=np.float32) / 255
_, mean_error, _ = flip_evaluator.evaluate(reference, test, "LDR", inputsRGB=True)
print(f"mean FLIP {mean_error:.4f}")
