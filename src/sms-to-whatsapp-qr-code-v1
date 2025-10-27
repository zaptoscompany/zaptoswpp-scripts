(function() {
  function trocarTexto() {
    const smsTab = document.querySelector('#sms-tab');
    if (smsTab && smsTab.innerText.trim() === 'SMS') {
      smsTab.innerText = 'WhatsApp QR';
    }
  }

  // Primeiro tenta de imediato
  trocarTexto();

  // Agora cria um MutationObserver que fica de olho em mudanças
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(() => {
      trocarTexto();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();