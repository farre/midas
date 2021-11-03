#include <todo.hpp>
#include <iostream>
#include <vector>

int main(int argc, const char** argv) {
	std::vector<Todo> todos;
	todos.push_back(Todo{"Make test app for debugger extension", Date{.day = 3, .month = 11, .year = 2021 }});
	todos.push_back(Todo{"Read code-debug & look for useful stuff", Date{.day = 4, .month = 11, .year = 2021 }});
	todos.push_back(Todo{"Read vscode-mock-debug & rip out things of use", Date{.day = 5, .month = 11, .year = 2021 }});

	std::cout << "Things to do: " << Todo::todo_count() << std::endl;
	for(const auto& t : todos) {
		std::cout << "\tTodo id " << t.id() << ": " << t.title() << " @" << t.date() << std::endl;
	}
	std::cout << "Goodbye cruel world" << std::endl;
}
