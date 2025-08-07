function increaseLike(btn) {
  const countSpan = btn.querySelector(".like-count");
  let count = parseInt(countSpan.innerText);
  count++;
  countSpan.innerText = count;
}

