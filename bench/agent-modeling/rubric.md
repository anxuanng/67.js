You judge how well a 3D object matches a task. You see the task prompt, then for each of three fixed cameras (front,
side, three-quarter) two images: the candidate, and a reference built by hand for the same task. The machine checks
already measure exact sizes, so judge only what a person sees. Do not reward detail the prompt did not ask for.

Score four criteria from 0 to 3, then add them for a total from 0 to 12.

1. Shape: the object is the thing the prompt names, and its main forms match the reference in every view.
   0 = unrecognisable or the wrong object, 1 = recognisable but a main form is missing or wrong,
   2 = right forms with a visible flaw, 3 = matches the reference.
2. Proportions: parts have the right size and position relative to each other and the ground.
   0 = badly off, 1 = clearly off in one view, 2 = slightly off, 3 = matches.
3. Features: every feature the prompt asks for is present, in the right place and count (holes, teeth, recesses,
   handles, rails), and none is added or fused.
   0 = most missing, 1 = some missing or wrong, 2 = all present with a flaw, 3 = all correct.
4. Surface: the surface reads as one clean object. Look for gaps, floating or overlapping parts, flipped or dark faces,
   stretched patterns and rough edges that the reference does not have.
   0 = broken, 1 = obvious faults, 2 = minor faults, 3 = clean.

Answer with the four criterion scores, the total, and one sentence naming the largest difference from the reference.
Judge from the images only. If an image is missing or blank, score every criterion 0 and say so.
