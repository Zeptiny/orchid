## TODO - Remover esta seção antes da entrega final
### Bugs
- Scrolling up is impossible
- Remove token usage from the tool output (wait_for_subagent) that is given to the subagent (Does not aggregate nothing useful)

### Problems
- LLM can deviate from the architecture
  - AGENT.MD and docs should fix that
- LLM can make dead code / not fully implement / not follow the plan
  - This should not be happening as the reviewers are exactly for that, what is wrong?
  - Subagents should make it easier to fully follow the plan
- The skills and agents are not updated for the current capabilities of the harness

### Interface
- Subagent names on the right sidebar does not use the subagent name
  - The status also starts as "interrupted"
- Remove the tool name in favor of a user redable name
  - Ex: delegate_to_subagent -> Delegated <task name> to subagent
  - Ex: wait_for_subagebt -> Waiting for X subagents (When opening to view the output, show the subagent names in a list) - if only one subagent "Waiting for <subagent task name> subagent"
  - This should happen to all tool
- Allow to view the background commands and send input when necessary
- Allow to view the running subagents output / while working
- Verify if all tool have a generating and running state
  - Edit / write appears to not have
- On subagent view, show first the running agents, with the agents on completed/finished statuses to be on a dropdown
- Execute command widget should show the command description on the title, with the command itself on the dropdown / content
- Chat appears to not use the full availiable width / x axis space
- Remove <selected> badge and <project> for selected sessions and procjets on the left sidebar - background / border is enough
- Add categories to the context overview
  - Tools -> Tool (Definition) and Tool use (Output)
  - Assistant -> Response and Reasoning
- Erros are not being returned / used correclty on the interface
  - Also needs to check if subagent errors are properly propagating
  - For example, API returned 429 but no message appeared on the interface

### TODOs geral
- Tools should start the execution as son as the generation is complete, even if the model is still generating output for other commands
- RAG/AST Post Write Callback + automatic updating if changes are detected (Can be changed via commands / manually / etc that post write callback does not detect)
- wait_for_subagent sending duplicated information
- Still work to do on 2026-07-15-electron-simplification-review.md
- Verify if remote embeddings model works correctly
- Subagents vieweing
- Do not re-parse markdown every update
- Controle de concorrência para travamento de arquivos
- LSP
- SSH / Remote Connection
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
- Sendo analizado: Permitir que os subagentes façam uso dessa ferramenta para perguntar ao agente principal
  - O agente principal deve ser capaz de saber imediatamente quando uma pergunta é feita (Atualizando o status + sair do wait_for_subagent se qualquer um tiver questão)
  - Deve ser capaz de não responder quando soube da pergunta (Para pesquisas ou mandar para o usuário)

### Sistema de aprovação / permissão
- Analizar a possibilidade de integrar os checks do https://github.com/Dicklesworthstone/destructive_command_guard
- Ferramentas teriam um novo atributo, sendo permissão, além de vários níveis de permissões:
  - Sempre perguntar
  - Permitir tudo / yolo
  - Decida por mim (Agente seed decide dependendo da chamada)
    - Claude Code tem esse sistema, ele pode ser analisado para melhorar o plano
  - Perguntar se for flagrado
    - Apenas se o destructive_command_guard marcar
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
- Correspondência difusa (fuzzy matching) na ferramenta edit
  - Por exemplo, opencode tem 9 maneira de fuzzy matching

### Configuração
- Adicionar provedor tem como colocar api key e env auth ao mesmo tempo
  - Deixar apenas um visivel, selecionado por botão
- Adicionar um MCP tem como colocar comandos e URL ao mesmo tempo
  - Deixar apenas um visivel, selecionado por botão
  - Não tem como colocar auth token

### Considerações
- Tornar a ferramenta read utilizável com diretórios?
