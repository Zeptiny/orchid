
## TODO - Remover esta seção antes da entrega final
### TODOs geral
- Permitir textual serve (Atualmente tem problema com AST)
- Controle de concorrência para travamento de arquivos
- LSP
- Tratamento de AGENTS.md
  - E também comando /init para ele
  - Quando usar o read tool em qualquer arquivo com um AGENTS.md em seu diretório deve ser colocada as regras junto
- Fila de mensagens para o usuário
- Seleção de níveis de pensamento
  - Isso é mais complexo pois não tem como saber os aceitos pelo provedor, nem se ele irá respeitar
  - O usuário deve ser capaz de configurar por modelo as variações de pensamento
  - Os agentes/subagentes devem ser capazes de aderirem um nível expecífico
    - Possível adotando o modelo <provedor>/<modelo>/<nível_de_pensamento> (Se utilizar <provedor>/<modelo>:<nivel_dePensamento> terá conflito com openrouter e com "-" de separador pode confundir com o nome)
    - Qual será o padrão? Por modelo? Global?

### Melhoria no sistema de compound
- OBS: Não mexer nele até ter uma ideia mais definida
- Múltiplos tipos de agente principal (Geral, plano, etc.) que podem ser alternados durante a conversa

### Ferramenta ask_question
- Deve permitir múltiplas questões de múltipla escolha
  - Cada uma contendo um título e descrição
- Deve permitir o usuário sempre enviar uma resposta em texto livre
- Deve permitir fazer múltiplas questões numa chamada
  - Ex: 2 questões de múltiplas escolha com 4 respostas, mais um com duas, etc.
- Sendo analizado: Permitir que os subagentes façam uso dessa ferramenta apra perguntar ao agente principal
  - O agente principal deve ser capaz de saber imediatamente quando uma pergunta é feita (Atualizando o status + sair do wait_for_subagent se qualquer um tiver questão)
  - Deve ser capaz de não responder quando soube da pergunta (Para pesquisas ou mandar para o usuário)

### Sistema de aprovação / permissão
- Ferramentas teriam um novo atributo, sendo permissão, além de vários níveis de permissões:
  - Sempre perguntar
  - Permitir tudo / yolo
  - Decida por mim (Agente tolo decide dependendo da chamada)
    - Claude Code tem esse sistema, ele pode ser analisado para melhorar o plano
- Resolver caminhos fornecidos nas ferramentas para evitar modificar/ler arquivos fora do diretório de trabalho
  - Mas isso ainda poderia ser evitado via comandos. Com sistema de permissão e o usuário aprovando todos os comandos, a responsabilidade fica com o usuário
- Também já adicionar o reconhecimento de diretórios que um comando / ferramenta irá afetar
  - Perguntar ao usuário se pode editar / visualziar arquivos fora do diretório atual
    - Ignorado no yolo 

### Subagentes
- Agente BTW/lateral (Fazer uma pergunta sem interromper o fluxo principal)
  - Precisa ser analizado a melhor maneira de colocar na interface
  - Apenas tools read only
  - Multi turno? Ainda sendo analisado
  - ütil para clarificações sem interromper o trabalho
    - Ex: "Como a função x interage com systema Y?"

### Precisa de melhoria
- 24 blocos `except Exception` nus que engolem erros silenciosamente em app.py
- Mensagens de erro vazam strings de comando e caminhos de arquivo em erros de execução de ferramentas (exec.py)
- Correspondência difusa (fuzzy matching) na ferramenta edit
  - Por exemplo, opencode tem 9 maneira de fuzzy matching
- Não mostrar [interrupted by user]
- Multiline todo items
- MCP Servers não tem o mesmo espaçamento da esquerda como Subagentes e todo


### Comandos
- Comandos que precisam de input
  - Ex: Perssione y para instalar
  - Agente deve ser capaz de responder
- Visualizar comandos executando em tempo real

### Bugs
- Rolagem automática para baixo após o fim de uma mensagem do agente
  - A conversa também não está indo automaticamente para baixo enquanto faz o streaming
- Algo pode estar bloqueando/não paralelo - quando múltiplos subagentes são instanciados, a CPU usa apenas um núcleo
- O tempo de indexação RAG e AST na barra lateral não é atualizado regularmente, ficando obsoleto
- Contexto não está sendo atualizado constantemente
  - Ainda precisa ser investigado

### Configuração
- Adicionar provedor tem como colcoar api key e env auth ao mesmo tempo
  - Deixar apenas um visivel, selecionado por botão
- Adicionar um MCP tem como colocar comandos e URL ao mesmo tempo
  - Deixar apenas um visivel, selecionado por botão
  - Não tem como colocar auth token

### Performance
- TUI parece meio "Choppy"?
  - Ex: travanado levemente no scroll

### Considerações
- Tornar a ferramenta read utilizável com diretórios?
- Remover a ferramenta list_subagents?
  - Já é includo no system prompt dinâmico o resultado dela
- Remover a ferramenta list_skills?
  - Já é includo no system prompt dinâmico o resultado dela

### Algumas regras básicas
- Apenas imports absolutos
- Estrutura orientada a domínio
- Seguir a lintagem do ruff (por favor)

---