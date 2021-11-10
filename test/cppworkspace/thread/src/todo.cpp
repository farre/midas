#include <todo.hpp>

int Todo::s_todo_id = 0;

Todo::Todo(const char* title, Date date) : m_id(s_todo_id++), m_date(date), m_title(title) {}

int Todo::todo_count() {
	return s_todo_id;
}

std::string_view Todo::title() const { return m_title; }
int Todo::id() const { return m_id; } 
const Date& Todo::date() const { return m_date; }
